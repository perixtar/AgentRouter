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
          "workspace.file_index_collected",
          "workspace.patch_collected",
          "run.completed"
        ]);
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
      });
    } finally {
      client.release();
    }
  }, 60_000);
});

class RecordingSandboxDriver implements WorkerSandboxDriver {
  readonly createdEnvSnapshots: Array<Record<string, string>> = [];
  readonly commands: string[] = [];
  readonly deletedSandboxIds: string[] = [];

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
        stdout: "?? reports/agent-smoke.txt\0",
        stderr: ""
      };
    }

    if (command.includes("git diff")) {
      return {
        exitCode: 0,
        stdout: "diff --git a/reports/agent-smoke.txt b/reports/agent-smoke.txt\n",
        stderr: ""
      };
    }

    if (command.includes("codex")) {
      return {
        exitCode: 0,
        stdout: "{\"type\":\"message\",\"message\":\"created reports/agent-smoke.txt\"}\n",
        stderr: "provider warning\n"
      };
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    this.deletedSandboxIds.push(sandboxId);
  }
}
