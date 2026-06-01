import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { parseAgentRouterEnv } from "@agentrouter/config";
import {
  RunRepository,
  applyPhase1Migrations,
  dropSchema,
  withSearchPath
} from "@agentrouter/db";
import { runOneWorkerIteration, type WorkerSandboxDriver } from "@agentrouter/worker";

loadDotEnv();

describe("worker run-one orchestration", () => {
  const config = parseAgentRouterEnv(process.env);
  const schema = `${config.testResourcePrefix}_${randomUUID().replaceAll("-", "_")}`;
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = new R2ArtifactStore(config.r2);
  const runId = `run_${randomUUID()}`;
  const sandbox = new RecordingSandboxDriver();

  beforeAll(async () => {
    const client = await pool.connect();
    try {
      await applyPhase1Migrations(client, schema);
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.createRun({
          id: runId,
          runtimeKind: "codex",
          runtimeMode: "default",
          runtimeModel: "gpt-4o",
          input: {
            task: "Create reports/agent-smoke.txt and summarize the change",
            runtime: { kind: "codex", mode: "default", model: "gpt-4o" }
          },
          promptSummary: "Create reports/agent-smoke.txt and summarize the change"
        });
      });
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await store.deleteRunPrefix(runId);
    const client = await pool.connect();
    try {
      await dropSchema(client, schema);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it("claims a run, launches Codex in a sandbox, writes events, archives logs/session, and cleans up", async () => {
    const result = await runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env
    });

    expect(result).toEqual({ processed: true, runId });
    expect(sandbox.createdEnvSnapshots[0]).not.toHaveProperty("CODEX_API_KEY");
    expect(sandbox.createdEnvSnapshots[0]).not.toHaveProperty("OPENAI_API_KEY");
    expect(sandbox.commands.some((command) => command.includes("codex"))).toBe(true);
    expect(sandbox.commands.find((command) => command.includes("'exec'"))).toContain(
      "'--model' 'gpt-4o'"
    );
    expect(sandbox.commands.find((command) => command.includes("git status"))).toContain(
      "--untracked-files=all"
    );
    expect(sandbox.commands.join("\n")).not.toContain(config.codexApiKey);
    expect(sandbox.deletedSandboxIds).toEqual(["sandbox_1"]);

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRun(runId);
        const events = await repo.listEvents({ runId });
        const artifacts = await repo.listArtifacts(runId);

        expect(run?.status).toBe("completed");
        expect(events.map((event) => event.eventType)).toEqual([
          "run.claimed",
          "sandbox.created",
          "provider.stdout",
          "provider.stderr",
          "agent.response",
          "workspace.file_index_collected",
          "workspace.patch_collected",
          "run.completed"
        ]);
        expect(events.find((event) => event.eventType === "agent.response")?.payload).toMatchObject({
          text: "created reports/agent-smoke.txt",
          provider: "codex"
        });
        expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
          "session_manifest",
          "stderr_log",
          "stdout_log",
          "workspace_file_index",
          "workspace_patch"
        ]);

        const stdout = artifacts.find((artifact) => artifact.kind === "stdout_log");
        expect(stdout).toBeDefined();
        const bytes = await store.getObjectBytes(stdout!.r2Key);
        expect(gunzipSync(bytes).toString("utf8")).toContain("created reports/agent-smoke.txt");

        const manifest = artifacts.find((artifact) => artifact.kind === "session_manifest");
        expect(manifest).toBeDefined();
        const manifestJson = JSON.parse(
          Buffer.from(await store.getObjectBytes(manifest!.r2Key)).toString("utf8")
        ) as { run: { status: string }; events: Array<{ type: string }> };
        expect(manifestJson.run.status).toBe("completed");
        expect(manifestJson.events.at(-1)?.type).toBe("run.completed");
      });
    } finally {
      client.release();
    }
  }, 60_000);

  it("claims a Claude Code run, launches it in a sandbox, writes events, archives artifacts, and cleans up", async () => {
    const claudeRunId = `run_${randomUUID()}`;
    const claudeSandbox = new RecordingSandboxDriver();

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        const repo = new RunRepository(setupClient);
        await repo.createRun({
          id: claudeRunId,
          runtimeKind: "claude_code",
          runtimeMode: "acceptEdits",
          runtimeModel: "claude-sonnet-4-6",
          input: {
            task: "Create reports/claude-smoke.txt and summarize the change",
            runtime: {
              kind: "claude_code",
              permissionMode: "acceptEdits",
              model: "claude-sonnet-4-6"
            }
          },
          promptSummary: "Create reports/claude-smoke.txt and summarize the change"
        });
      });
    } finally {
      setupClient.release();
    }

    const result = await runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: claudeSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      anthropicApiKey: "sk-ant-worker-canary",
      baseEnv: process.env
    });

    expect(result).toEqual({ processed: true, runId: claudeRunId });
    expect(claudeSandbox.createdEnvSnapshots[0]).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(claudeSandbox.commands.some((command) => command.includes("'claude'"))).toBe(true);
    const claudeBootstrapCommand = claudeSandbox.commands.find((command) =>
      command.includes("CLAUDE_PREFIX=/home/daytona/.agentrouter-claude/npm-global")
    );
    expect(claudeBootstrapCommand).toContain("NPM_CONFIG_PREFIX");
    expect(claudeBootstrapCommand).toContain("@anthropic-ai/claude-code@latest");
    expect(claudeBootstrapCommand).toContain("--bare");
    expect(claudeSandbox.commands.find((command) => command.includes("'claude'"))).toContain(
      "'--permission-mode' 'acceptEdits'"
    );
    expect(claudeSandbox.commands.find((command) => command.includes("'claude'"))).toContain(
      "'--model' 'claude-sonnet-4-6'"
    );
    expect(claudeSandbox.commands.join("\n")).not.toContain("sk-ant-worker-canary");
    expect(claudeSandbox.deletedSandboxIds).toEqual(["sandbox_1"]);

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRun(claudeRunId);
        const events = await repo.listEvents({ runId: claudeRunId });
        const artifacts = await repo.listArtifacts(claudeRunId);

        expect(run?.status).toBe("completed");
        expect(events.find((event) => event.eventType === "provider.stdout")?.source).toBe(
          "claude_code"
        );
        expect(events.find((event) => event.eventType === "agent.response")?.payload).toMatchObject({
          text: "created reports/claude-smoke.txt",
          provider: "claude_code"
        });
        expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
          "session_manifest",
          "stderr_log",
          "stdout_log",
          "workspace_file_index",
          "workspace_patch"
        ]);
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(claudeRunId);
    }
  }, 60_000);

  it("records structured Claude Code provider errors on failed runs", async () => {
    const claudeFailureRunId = `run_${randomUUID()}`;
    const claudeFailureSandbox = new RecordingSandboxDriver({
      claudeExitCode: 1,
      claudeStdout:
        '{"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"}\n'
    });

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        const repo = new RunRepository(setupClient);
        await repo.createRun({
          id: claudeFailureRunId,
          runtimeKind: "claude_code",
          runtimeMode: "default",
          input: {
            task: "Reply with a short status",
            runtime: {
              kind: "claude_code",
              permissionMode: "default"
            }
          },
          promptSummary: "Reply with a short status"
        });
      });
    } finally {
      setupClient.release();
    }

    const result = await runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: claudeFailureSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      anthropicApiKey: "sk-ant-worker-canary",
      baseEnv: process.env
    });

    expect(result).toEqual({ processed: true, runId: claudeFailureRunId });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRun(claudeFailureRunId);
        const events = await repo.listEvents({ runId: claudeFailureRunId });

        expect(run?.status).toBe("failed");
        expect(run?.failureReason).toBe(
          "Claude Code process exited non-zero: Credit balance is too low"
        );
        expect(events.at(-1)?.eventType).toBe("run.failed");
        expect(events.at(-1)?.payload.reason).toBe(run?.failureReason);

        const artifacts = await repo.listArtifacts(claudeFailureRunId);
        const manifest = artifacts.find((artifact) => artifact.kind === "session_manifest");
        expect(manifest).toBeDefined();
        const manifestJson = JSON.parse(
          Buffer.from(await store.getObjectBytes(manifest!.r2Key)).toString("utf8")
        ) as {
          run: { status: string; failure?: { reason?: string } };
          events: Array<{ type: string }>;
        };
        expect(manifestJson.run.status).toBe("failed");
        expect(manifestJson.run.failure?.reason).toBe(run?.failureReason);
        expect(manifestJson.events.at(-1)?.type).toBe("run.failed");
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(claudeFailureRunId);
    }
  }, 60_000);

  it("fails before archiving a workspace patch that contains a provider credential", async () => {
    const leakRunId = `run_${randomUUID()}`;
    const credentialCanary = "sk-codex-worker-canary";
    const leakingSandbox = new RecordingSandboxDriver({
      gitDiffStdout:
        "diff --git a/reports/leak.txt b/reports/leak.txt\n" +
        "new file mode 100644\n" +
        "index 0000000..1111111\n" +
        "--- /dev/null\n" +
        "+++ b/reports/leak.txt\n" +
        `+${credentialCanary}\n`
    });

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        const repo = new RunRepository(setupClient);
        await repo.createRun({
          id: leakRunId,
          runtimeKind: "codex",
          runtimeMode: "default",
          input: {
            task: "Create a report",
            runtime: { kind: "codex", mode: "default" }
          },
          promptSummary: "Create a report"
        });
      });
    } finally {
      setupClient.release();
    }

    const result = await runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: leakingSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: credentialCanary,
      baseEnv: process.env
    });

    expect(result).toEqual({ processed: true, runId: leakRunId });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRun(leakRunId);
        const events = await repo.listEvents({ runId: leakRunId });
        const artifacts = await repo.listArtifacts(leakRunId);

        expect(run?.status).toBe("failed");
        expect(run?.failureReason).toBe("Credential canary leaked through workspace patch");
        expect(events.at(-1)?.eventType).toBe("run.failed");
        expect(artifacts.map((artifact) => artifact.kind)).not.toContain("workspace_patch");
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(leakRunId);
    }
  }, 60_000);
});

interface RecordingSandboxDriverOptions {
  claudeExitCode?: number;
  claudeStdout?: string;
  claudeStderr?: string;
  codexStdout?: string;
  codexStderr?: string;
  gitDiffStdout?: string;
  gitStatusStdout?: string;
}

class RecordingSandboxDriver implements WorkerSandboxDriver {
  readonly createdEnvSnapshots: Array<Record<string, string>> = [];
  readonly commands: string[] = [];
  readonly deletedSandboxIds: string[] = [];

  constructor(private readonly options: RecordingSandboxDriverOptions = {}) {}

  async createSandbox(input: {
    name: string;
    env?: Record<string, string>;
  }): Promise<{ id: string; name?: string }> {
    this.createdEnvSnapshots.push(input.env ?? {});
    return { id: "sandbox_1", name: input.name };
  }

  async executeCommand(
    _sandboxId: string,
    command: string,
    _options?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.commands.push(command);

    if (command.includes("git status")) {
      return {
        exitCode: 0,
        stdout: this.options.gitStatusStdout ?? "?? reports/agent-smoke.txt\0",
        stderr: ""
      };
    }

    if (command.includes("git diff")) {
      return {
        exitCode: 0,
        stdout:
          this.options.gitDiffStdout ??
          "diff --git a/reports/agent-smoke.txt b/reports/agent-smoke.txt\n",
        stderr: ""
      };
    }

    if (command.includes("command -v claude")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (command.includes("'claude'")) {
      return {
        exitCode: this.options.claudeExitCode ?? 0,
        stdout:
          this.options.claudeStdout ??
          "{\"type\":\"result\",\"result\":\"created reports/claude-smoke.txt\"}\n",
        stderr: this.options.claudeStderr ?? "claude warning\n"
      };
    }

    if (command.includes("'codex'")) {
      return {
        exitCode: 0,
        stdout:
          this.options.codexStdout ??
          "{\"type\":\"message\",\"message\":\"created reports/agent-smoke.txt\"}\n",
        stderr: this.options.codexStderr ?? "provider warning\n"
      };
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.deletedSandboxIds.push(sandboxId);
  }
}
