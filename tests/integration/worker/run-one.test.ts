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
  type EventRecord,
  withSearchPath
} from "@agentrouter/db";
import { CREDENTIAL_BOUNDARY_PROBE_MARKER } from "@agentrouter/credential-boundary";
import {
  reapExpiredSandboxes,
  runOneWorkerIteration,
  type WorkerSandboxDriver
} from "@agentrouter/worker";

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
        const run = await repo.getRunInternal(runId);
        const events = await repo.listEventsInternal({ runId });
        const artifacts = await repo.listArtifactsInternal(runId);

        expect(run?.status).toBe("completed");
        expect(events.map((event) => event.eventType)).toEqual([
          "run.claimed",
          "sandbox.created",
          "credential_boundary.verified",
          "action.proposed",
          "policy.evaluated",
          "execution.started",
          "execution.completed",
          "provider.stdout",
          "provider.stderr",
          "agent.message",
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
          "session_events",
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

        const sessionEvents = artifacts.find((artifact) => artifact.kind === "session_events");
        expect(sessionEvents).toBeDefined();
        const eventArchive = Buffer.from(
          await store.getObjectBytes(sessionEvents!.r2Key)
        ).toString("utf8");
        expect(eventArchive.trim().split("\n").map((line) => JSON.parse(line).type)).toEqual(
          events.map((event) => event.eventType)
        );
      });
    } finally {
      client.release();
    }
  }, 60_000);

  it("parks a self-hosted system org Codex run so it can be continued by run id", async () => {
    // The self-hosted API key path resolves to the "org_system" sentinel. It
    // should still support the public run-id continuation surface, using the
    // configured provider key from the worker environment.
    const systemRunId = `run_${randomUUID()}`;
    const systemSandbox = new RecordingSandboxDriver();

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        const repo = new RunRepository(setupClient);
        await repo.createRun({
          id: systemRunId,
          orgId: "org_system",
          runtimeKind: "codex",
          runtimeMode: "full_access",
          runtimeModel: "gpt-4o",
          input: {
            task: "Create reports/system-smoke.txt and summarize the change",
            runtime: { kind: "codex", mode: "full_access", model: "gpt-4o" }
          },
          promptSummary: "Create reports/system-smoke.txt and summarize the change"
        });
      });
    } finally {
      setupClient.release();
    }

    const result = await runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: systemSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env
    });

    expect(result).toEqual({ processed: true, runId: systemRunId });
    expect(systemSandbox.createdSandboxInputs[0]).toMatchObject({
      persistent: true,
      autoDeleteIntervalMinutes: 90,
      autoStopIntervalMinutes: 15
    });
    expect(systemSandbox.suspendedSandboxIds).toEqual(["sandbox_1"]);
    expect(systemSandbox.deletedSandboxIds).toEqual([]);

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRunInternal(systemRunId);
        const events = await repo.listEventsInternal({ runId: systemRunId });

        expect(run?.status).toBe("completed");
        // No uuid error surfaced as a failure reason.
        expect(run?.failureReason ?? "").not.toContain("uuid");
        expect(events.map((event) => event.eventType)).toEqual(
          expect.arrayContaining(["run.completed", "sandbox.parked"])
        );
        expect(events.at(-1)?.eventType).toBe("sandbox.parked");
        const session = await repo.findSessionByRunId(systemRunId, "org_system");
        expect(session).toMatchObject({
          originRunId: systemRunId,
          sandboxId: "sandbox_1",
          sandboxState: "suspended",
          status: "active",
          turnCount: 1
        });
        const turns = await repo.listTurns(session!.id, "org_system");
        expect(turns).toEqual([
          expect.objectContaining({
            runId: systemRunId,
            turnNumber: 1,
            prompt: "Create reports/system-smoke.txt and summarize the change"
          })
        ]);
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(systemRunId);
    }
  }, 60_000);

  it("records normalized progress events while provider stdout is streaming", async () => {
    const streamingRunId = `run_${randomUUID()}`;
    const streamingSandbox = new StreamingRecordingSandboxDriver({
      stdoutChunks: [
        `${JSON.stringify({ type: "thread.started", thread_id: "thread_stream" })}\n`,
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Checked the repo state." }],
            content: [{ type: "reasoning_text", text: "raw hidden reasoning" }]
          }
        })}\n`,
        `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "created reports/streaming.txt" }
        })}\n`,
        `${JSON.stringify({ type: "result", result: "done" })}\n`
      ]
    });

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        const repo = new RunRepository(setupClient);
        await repo.createRun({
          id: streamingRunId,
          runtimeKind: "codex",
          runtimeMode: "default",
          runtimeModel: "gpt-4o",
          input: {
            task: "Create reports/streaming.txt and summarize the change",
            runtime: { kind: "codex", mode: "default", model: "gpt-4o" }
          },
          promptSummary: "Create reports/streaming.txt and summarize the change"
        });
      });
    } finally {
      setupClient.release();
    }

    const result = await runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: streamingSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env
    });

    expect(result).toEqual({ processed: true, runId: streamingRunId });
    expect(streamingSandbox.streamedCommands).toHaveLength(1);

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const events = await repo.listEventsInternal({ runId: streamingRunId });
        const eventTypes = events.map((event) => event.eventType);

        expect(eventTypes).toEqual([
          "run.claimed",
          "sandbox.created",
          "credential_boundary.verified",
          "action.proposed",
          "policy.evaluated",
          "execution.started",
          "agent.started",
          "agent.progress",
          "agent.message",
          "agent.completed",
          "execution.completed",
          "provider.stdout",
          "provider.stderr",
          "agent.response",
          "workspace.file_index_collected",
          "workspace.patch_collected",
          "run.completed"
        ]);
        expect(events.find((event) => event.eventType === "agent.progress")?.payload).toMatchObject(
          {
            provider: "codex",
            summary: "Checked the repo state."
          }
        );
        expect(JSON.stringify(events.map((event) => event.payload))).not.toContain(
          "raw hidden reasoning"
        );
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(streamingRunId);
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
          orgId: "org_test",
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
        const run = await repo.getRun(claudeRunId, "org_test");
        const events = await repo.listEvents({ runId: claudeRunId, orgId: "org_test" });
        const artifacts = await repo.listArtifacts(claudeRunId, "org_test");

        expect(run?.status).toBe("completed");
        expect(events.find((event) => event.eventType === "provider.stdout")?.source).toBe(
          "claude_code"
        );
        expect(events.find((event) => event.eventType === "agent.response")?.payload).toMatchObject({
          text: "created reports/claude-smoke.txt",
          provider: "claude_code"
        });
        expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual([
          "session_events",
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

  it("binds a manual Codex approval to the same digest before execution", async () => {
    const manualRunId = `run_${randomUUID()}`;
    const manualSandbox = new RecordingSandboxDriver();

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        const repo = new RunRepository(setupClient);
        await repo.createRun({
          id: manualRunId,
          orgId: "org_test",
          runtimeKind: "codex",
          runtimeMode: "default",
          runtimeModel: "gpt-4o",
          input: {
            task: "Create reports/manual-codex.txt",
            approvalMode: "manual",
            runtime: { kind: "codex", mode: "default", model: "gpt-4o" }
          },
          promptSummary: "Create reports/manual-codex.txt"
        });
      });
    } finally {
      setupClient.release();
    }

    const worker = runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: manualSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env
    });

    const requested = await waitForEvent(pool, schema, manualRunId, "approval.requested");
    await appendApprovalDecision(pool, schema, manualRunId, requested, "approved");

    await expect(worker).resolves.toEqual({ processed: true, runId: manualRunId });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const events = await repo.listEventsInternal({ runId: manualRunId });

        assertCausalActionChain(events, {
          policyDecision: "requires_approval",
          approvalDecision: "approved",
          executionTerminalEvent: "execution.completed"
        });
        expect(events.map((event) => event.eventType)).toEqual(
          expect.arrayContaining([
            "action.proposed",
            "policy.evaluated",
            "approval.requested",
            "approval.decided",
            "execution.started",
            "execution.completed",
            "provider.stdout",
            "run.completed"
          ])
        );
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(manualRunId);
    }
  }, 60_000);

  it("binds a manual Claude Code approval to the same digest before execution", async () => {
    const manualRunId = `run_${randomUUID()}`;
    const manualSandbox = new RecordingSandboxDriver();

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        const repo = new RunRepository(setupClient);
        await repo.createRun({
          id: manualRunId,
          orgId: "org_test",
          runtimeKind: "claude_code",
          runtimeMode: "acceptEdits",
          runtimeModel: "claude-sonnet-4-6",
          input: {
            task: "Create reports/manual-claude.txt",
            approvalMode: "manual",
            runtime: {
              kind: "claude_code",
              permissionMode: "acceptEdits",
              model: "claude-sonnet-4-6"
            }
          },
          promptSummary: "Create reports/manual-claude.txt"
        });
      });
    } finally {
      setupClient.release();
    }

    const worker = runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: manualSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      anthropicApiKey: "sk-ant-worker-canary",
      baseEnv: process.env
    });

    const requested = await waitForEvent(pool, schema, manualRunId, "approval.requested");
    await appendApprovalDecision(pool, schema, manualRunId, requested, "approved");

    await expect(worker).resolves.toEqual({ processed: true, runId: manualRunId });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const events = await new RunRepository(client).listEventsInternal({ runId: manualRunId });

        assertCausalActionChain(events, {
          policyDecision: "requires_approval",
          approvalDecision: "approved",
          executionTerminalEvent: "execution.completed"
        });
        expect(events.find((event) => event.eventType === "provider.stdout")?.source).toBe(
          "claude_code"
        );
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(manualRunId);
    }
  }, 60_000);

  it("does not execute when policy blocks the proposed action", async () => {
    const blockedRunId = `run_${randomUUID()}`;
    const blockedSandbox = new RecordingSandboxDriver();

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        await new RunRepository(setupClient).createRun({
          id: blockedRunId,
          orgId: "org_test",
          runtimeKind: "codex",
          runtimeMode: "default",
          input: {
            task: "Create reports/blocked.txt",
            approvalMode: "block",
            runtime: { kind: "codex", mode: "default" }
          },
          promptSummary: "Create reports/blocked.txt"
        });
      });
    } finally {
      setupClient.release();
    }

    await expect(
      runOneWorkerIteration({
        pool,
        schema,
        workerId: `worker_${randomUUID()}`,
        sandbox: blockedSandbox,
        artifactStore: store,
        testResourcePrefix: config.testResourcePrefix,
        codexApiKey: config.codexApiKey,
        baseEnv: process.env
      })
    ).resolves.toEqual({ processed: true, runId: blockedRunId });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRun(blockedRunId, "org_test");
        const events = await repo.listEvents({ runId: blockedRunId, orgId: "org_test" });

        expect(run?.status).toBe("failed");
        expect(events.map((event) => event.eventType)).toEqual(
          expect.arrayContaining(["action.proposed", "policy.evaluated", "run.failed"])
        );
        expect(events.find((event) => event.eventType === "policy.evaluated")?.payload).toMatchObject({
          decision: "blocked",
          terminalState: "blocked"
        });
        expect(events.map((event) => event.eventType)).not.toContain("execution.started");
        expect(events.map((event) => event.eventType)).not.toContain("provider.stdout");
        expect(blockedSandbox.commands.some((command) => command.includes("'codex'"))).toBe(false);
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(blockedRunId);
    }
  }, 60_000);

  it("does not execute when a human denies approval", async () => {
    const deniedRunId = `run_${randomUUID()}`;
    const deniedSandbox = new RecordingSandboxDriver();

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        await new RunRepository(setupClient).createRun({
          id: deniedRunId,
          orgId: "org_test",
          runtimeKind: "codex",
          runtimeMode: "default",
          input: {
            task: "Create reports/denied.txt",
            approvalMode: "manual",
            runtime: { kind: "codex", mode: "default" }
          },
          promptSummary: "Create reports/denied.txt"
        });
      });
    } finally {
      setupClient.release();
    }

    const worker = runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: deniedSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env
    });

    const requested = await waitForEvent(pool, schema, deniedRunId, "approval.requested");
    await appendApprovalDecision(pool, schema, deniedRunId, requested, "denied");
    await expect(worker).resolves.toEqual({ processed: true, runId: deniedRunId });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRun(deniedRunId, "org_test");
        const events = await repo.listEvents({ runId: deniedRunId, orgId: "org_test" });

        expect(run?.status).toBe("failed");
        assertCausalActionChain(events, {
          policyDecision: "requires_approval",
          approvalDecision: "denied"
        });
        expect(events.map((event) => event.eventType)).not.toContain("execution.started");
        expect(events.map((event) => event.eventType)).not.toContain("provider.stdout");
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(deniedRunId);
    }
  }, 60_000);

  it("does not execute when approval is granted for a different digest", async () => {
    const mismatchRunId = `run_${randomUUID()}`;
    const mismatchSandbox = new RecordingSandboxDriver();

    const setupClient = await pool.connect();
    try {
      await withSearchPath(setupClient, schema, async () => {
        await new RunRepository(setupClient).createRun({
          id: mismatchRunId,
          orgId: "org_test",
          runtimeKind: "codex",
          runtimeMode: "default",
          input: {
            task: "Create reports/mismatch.txt",
            approvalMode: "manual",
            runtime: { kind: "codex", mode: "default" }
          },
          promptSummary: "Create reports/mismatch.txt"
        });
      });
    } finally {
      setupClient.release();
    }

    const worker = runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: mismatchSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env
    });

    const requested = await waitForEvent(pool, schema, mismatchRunId, "approval.requested");
    await appendApprovalDecision(pool, schema, mismatchRunId, requested, "approved", {
      actionDigest: "sha256:different_digest"
    });
    await expect(worker).resolves.toEqual({ processed: true, runId: mismatchRunId });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRun(mismatchRunId, "org_test");
        const events = await repo.listEvents({ runId: mismatchRunId, orgId: "org_test" });

        expect(run?.status).toBe("failed");
        expect(run?.failureCode).toBe("approval_digest_mismatch");
        expect(events.map((event) => event.eventType)).not.toContain("execution.started");
        expect(events.map((event) => event.eventType)).not.toContain("provider.stdout");
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(mismatchRunId);
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
          orgId: "org_test",
          runtimeKind: "claude_code",
          runtimeMode: "default",
          input: {
            task: "Reply with a short status",
            approvalMode: "manual",
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

    const worker = runOneWorkerIteration({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: claudeFailureSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      anthropicApiKey: "sk-ant-worker-canary",
      baseEnv: process.env
    });

    const requested = await waitForEvent(pool, schema, claudeFailureRunId, "approval.requested");
    await appendApprovalDecision(pool, schema, claudeFailureRunId, requested, "approved");
    const result = await worker;
    expect(result).toEqual({ processed: true, runId: claudeFailureRunId });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRun(claudeFailureRunId, "org_test");
        const events = await repo.listEvents({ runId: claudeFailureRunId, orgId: "org_test" });

        expect(run?.status).toBe("failed");
        expect(run?.failureReason).toBe(
          "Claude Code process exited non-zero: Credit balance is too low"
        );
        assertCausalActionChain(events, {
          policyDecision: "requires_approval",
          approvalDecision: "approved",
          executionTerminalEvent: "execution.failed"
        });
        expect(events.at(-1)?.eventType).toBe("run.failed");
        expect(events.at(-1)?.payload.reason).toBe(run?.failureReason);

        const artifacts = await repo.listArtifacts(claudeFailureRunId, "org_test");
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

  it("fails before provider launch when the sandbox credential probe sees a provider canary", async () => {
    const leakRunId = `run_${randomUUID()}`;
    const credentialCanary = "sk-codex-probe-canary";
    const leakingSandbox = new RecordingSandboxDriver({
      credentialProbeStdout: `unexpected ${credentialCanary}`
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
    expect(leakingSandbox.commands.some((command) => command.includes("'codex'"))).toBe(false);

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const run = await repo.getRunInternal(leakRunId);
        const events = await repo.listEventsInternal({ runId: leakRunId });

        expect(run?.status).toBe("failed");
        expect(run?.failureReason).toBe("Credential canary leaked through credential boundary probe");
        expect(events.at(-1)?.eventType).toBe("run.failed");
      });
    } finally {
      client.release();
      await store.deleteRunPrefix(leakRunId);
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
        const run = await repo.getRunInternal(leakRunId);
        const events = await repo.listEventsInternal({ runId: leakRunId });
        const artifacts = await repo.listArtifactsInternal(leakRunId);

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

  it("reaps only expired suspended session sandboxes (the 30 GiB safety net)", async () => {
    const reaperSandbox = new RecordingSandboxDriver();
    const orgId = "org_reaper_test";
    const expiredRun = `run_${randomUUID()}`;
    const freshRun = `run_${randomUUID()}`;
    const expiredSandboxId = `sandbox_expired_${randomUUID()}`;
    const freshSandboxId = `sandbox_fresh_${randomUUID()}`;
    let expiredSession = "";
    let freshSession = "";

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        for (const [rid, sandboxId, deadlineMs, target] of [
          [expiredRun, expiredSandboxId, -60_000, "expired"],
          [freshRun, freshSandboxId, 10 * 60_000, "fresh"]
        ] as const) {
          await repo.createRun({
            id: rid,
            orgId,
            runtimeKind: "codex",
            runtimeMode: "full_access",
            input: { task: "t" },
            promptSummary: "t"
          });
          await repo.updateRunStatus(rid, "starting");
          await repo.updateRunStatus(rid, "running");
          await repo.updateRunStatus(rid, "completed");
          const sid = `sess_${randomUUID()}`;
          if (target === "expired") expiredSession = sid;
          else freshSession = sid;
          await repo.promoteRunToSession({
            sessionId: sid,
            runId: rid,
            orgId,
            runtimeKind: "codex",
            runtimeMode: "full_access",
            prompt: "t",
            sandboxId,
            sandboxState: "suspended",
            idleDeadlineAt: new Date(Date.now() + deadlineMs)
          });
        }
      });
    } finally {
      client.release();
    }

    const reaped = await reapExpiredSandboxes({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: reaperSandbox,
      artifactStore: store,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env
    });

    // Only the expired sandbox is deleted; the fresh one is untouched.
    expect(reaped).toBe(1);
    expect(reaperSandbox.deletedSandboxIds).toEqual([expiredSandboxId]);

    const verifyClient = await pool.connect();
    try {
      await withSearchPath(verifyClient, schema, async () => {
        const repo = new RunRepository(verifyClient);
        const expired = await repo.getSession(expiredSession, orgId);
        const fresh = await repo.getSession(freshSession, orgId);
        expect(expired?.sandboxState).toBe("deleted");
        expect(expired?.status).toBe("closed");
        expect(fresh?.sandboxState).toBe("suspended");
        expect(fresh?.status).toBe("active");
      });
    } finally {
      verifyClient.release();
    }
  }, 30_000);
});

async function waitForEvent(
  pool: Pool,
  schema: string,
  runId: string,
  eventType: string
): Promise<EventRecord> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const client = await pool.connect();
    try {
      const event = await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        return (await repo.listEventsInternal({ runId })).find(
          (item) => item.eventType === eventType
        );
      });
      if (event) return event;
    } finally {
      client.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${eventType} on ${runId}`);
}

async function appendApprovalDecision(
  pool: Pool,
  schema: string,
  runId: string,
  requested: EventRecord,
  decision: "approved" | "denied",
  overrides: { actionDigest?: string } = {}
): Promise<EventRecord> {
  const requestedPayload = requested.payload;
  const actionId = stringPayload(requestedPayload, "actionId");
  const actionDigest = overrides.actionDigest ?? stringPayload(requestedPayload, "actionDigest");
  const argsDigest = stringPayload(requestedPayload, "argsDigest");
  const client = await pool.connect();
  try {
    return await withSearchPath(client, schema, async () =>
      new RunRepository(client).appendEvent({
        runId,
        source: "api",
        eventType: "approval.decided",
        visibility: "public",
        payload: {
          eventId: `evt_${randomUUID()}`,
          priorEventId: stringPayload(requestedPayload, "eventId"),
          actionId,
          actionDigest,
          argsDigest,
          actor: "human",
          decisionId: `decision_${randomUUID()}`,
          decision,
          terminalState: decision === "denied" ? "denied" : undefined
        }
      })
    );
  } finally {
    client.release();
  }
}

function assertCausalActionChain(
  events: EventRecord[],
  expectation: {
    policyDecision: "allowed" | "requires_approval" | "blocked";
    approvalDecision?: "approved" | "denied";
    executionTerminalEvent?: "execution.completed" | "execution.failed";
  }
): void {
  const proposed = eventOf(events, "action.proposed");
  const policy = eventOf(events, "policy.evaluated");
  const actionId = stringPayload(proposed.payload, "actionId");
  const actionDigest = stringPayload(proposed.payload, "actionDigest");

  expect(policy.payload).toMatchObject({
    priorEventId: proposed.payload.eventId,
    actionId,
    actionDigest,
    decision: expectation.policyDecision
  });

  const approval = events.find((event) => event.eventType === "approval.decided");
  if (expectation.approvalDecision) {
    expect(approval?.payload).toMatchObject({
      actionId,
      actionDigest:
        expectation.approvalDecision === "approved" ? actionDigest : approval?.payload.actionDigest,
      decision: expectation.approvalDecision
    });
  } else {
    expect(approval).toBeUndefined();
  }

  const started = events.find((event) => event.eventType === "execution.started");
  const terminalExecution = expectation.executionTerminalEvent
    ? eventOf(events, expectation.executionTerminalEvent)
    : undefined;

  if (terminalExecution) {
    expect(started?.payload).toMatchObject({ actionId, actionDigest });
    expect(terminalExecution.payload).toMatchObject({ actionId, actionDigest });
  } else {
    expect(started).toBeUndefined();
  }
}

function eventOf(events: EventRecord[], eventType: string): EventRecord {
  const event = events.find((item) => item.eventType === eventType);
  if (!event) throw new Error(`Missing event ${eventType}`);
  return event;
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`Expected string payload ${key}`);
  return value;
}

interface RecordingSandboxDriverOptions {
  claudeExitCode?: number;
  claudeStdout?: string;
  claudeStderr?: string;
  codexStdout?: string;
  codexStderr?: string;
  credentialProbeStdout?: string;
  credentialProbeStderr?: string;
  gitDiffStdout?: string;
  gitStatusStdout?: string;
}

class RecordingSandboxDriver implements WorkerSandboxDriver {
  readonly createdEnvSnapshots: Array<Record<string, string>> = [];
  readonly createdSandboxInputs: Array<{
    name: string;
    env?: Record<string, string>;
    persistent?: boolean;
    autoStopIntervalMinutes?: number;
    autoDeleteIntervalMinutes?: number;
  }> = [];
  readonly commands: string[] = [];
  readonly deletedSandboxIds: string[] = [];
  readonly resumedSandboxIds: string[] = [];
  readonly suspendedSandboxIds: string[] = [];

  constructor(private readonly options: RecordingSandboxDriverOptions = {}) {}

  async createSandbox(input: {
    name: string;
    env?: Record<string, string>;
    persistent?: boolean;
    autoStopIntervalMinutes?: number;
    autoDeleteIntervalMinutes?: number;
  }): Promise<{ id: string; name?: string }> {
    this.createdEnvSnapshots.push(input.env ?? {});
    this.createdSandboxInputs.push(input);
    return { id: "sandbox_1", name: input.name };
  }

  async executeCommand(
    _sandboxId: string,
    command: string,
    _options?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.commands.push(command);

    if (command.includes(CREDENTIAL_BOUNDARY_PROBE_MARKER)) {
      return {
        exitCode: 0,
        stdout: this.options.credentialProbeStdout ?? "probe ok\n",
        stderr: this.options.credentialProbeStderr ?? ""
      };
    }

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

  async suspendSandbox(sandboxId: string): Promise<void> {
    this.suspendedSandboxIds.push(sandboxId);
  }

  async resumeSandbox(sandboxId: string): Promise<void> {
    this.resumedSandboxIds.push(sandboxId);
  }
}

class StreamingRecordingSandboxDriver extends RecordingSandboxDriver {
  readonly streamedCommands: string[] = [];

  constructor(private readonly streamOptions: { stdoutChunks: string[]; stderrChunks?: string[] }) {
    super({
      gitStatusStdout: "?? reports/streaming.txt\0",
      gitDiffStdout: "diff --git a/reports/streaming.txt b/reports/streaming.txt\n"
    });
  }

  async executeCommandStreaming(
    _sandboxId: string,
    command: string,
    _options: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number } | undefined,
    onOutput: (chunk: { stream: "stdout" | "stderr"; text: string }) => Promise<void> | void
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.streamedCommands.push(command);
    for (const chunk of this.streamOptions.stdoutChunks) {
      await onOutput({ stream: "stdout", text: chunk });
    }
    for (const chunk of this.streamOptions.stderrChunks ?? ["provider warning\n"]) {
      await onOutput({ stream: "stderr", text: chunk });
    }

    return {
      exitCode: 0,
      stdout: this.streamOptions.stdoutChunks.join(""),
      stderr: (this.streamOptions.stderrChunks ?? ["provider warning\n"]).join("")
    };
  }
}
