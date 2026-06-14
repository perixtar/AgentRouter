import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import {
  agentrouter,
  codex,
  streamAgent
} from "@agentrouterhq/sdk";
import { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { buildApiServer } from "@agentrouter/api";
import { parseAgentRouterEnv } from "@agentrouter/config";
import { applyPhase1Migrations, dropSchema } from "@agentrouter/db";
import { DaytonaSandboxDriver } from "@agentrouter/sandbox-daytona";
import { reapExpiredSandboxes, runOneWorkerIteration, runWorkerLoop } from "@agentrouter/worker";
import { assertSuccessfulE2ERun, collectEventsAndApproveActions } from "./assertions.js";

loadDotEnv();

const describeRealE2E = process.env.AGENTROUTER_RUN_REAL_E2E === "1" ? describe : describe.skip;

describeRealE2E("real Codex API + worker E2E", () => {
  const config = parseAgentRouterEnv(process.env);
  const schema = `${config.testResourcePrefix}_${randomUUID().replaceAll("-", "_")}`;
  const pool = new Pool({ connectionString: config.databaseUrl });
  const artifactStore = new R2ArtifactStore(config.r2);
  const server = buildApiServer({
    pool,
    schema,
    apiKey: config.apiKey,
    artifactBytes: artifactStore
  });
  let baseUrl = "";
  const runIds: string[] = [];

  beforeAll(async () => {
    const client = await pool.connect();
    try {
      await applyPhase1Migrations(client, schema);
    } finally {
      client.release();
    }

    await server.listen({ port: 0, host: "127.0.0.1" });
    const address = server.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await Promise.all(runIds.map((runId) => artifactStore.deleteRunPrefix(runId)));

    const client = await pool.connect();
    try {
      await dropSchema(client, schema);
    } finally {
      client.release();
      await server.close();
      await pool.end();
    }
  });

  it("streams, archives, restores, and drains a real Codex coding run", async () => {
    const sdk = agentrouter({ baseUrl, apiKey: config.apiKey });
    const runtimeModel = process.env.AGENTROUTER_MODEL;
    const controller = new AbortController();
    const worker = runWorkerLoop({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: new DaytonaSandboxDriver({
        apiKey: config.daytonaApiKey,
        testResourcePrefix: config.testResourcePrefix
      }),
      artifactStore,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env,
      signal: controller.signal,
      pollIntervalMs: 250
    });

    try {
      const stream = await streamAgent({
        client: sdk,
        pollIntervalMs: 500,
        maxWaitMs: 10 * 60 * 1000,
        task:
          "Use the shell tool to run exactly: mkdir -p reports && printf 'AR_CODEX_E2E_OK\\n' > reports/agent-smoke.txt. Then summarize the change in one sentence.",
        approvalMode: "manual",
        runtime: codex({ mode: "full_access", ...(runtimeModel ? { model: runtimeModel } : {}) })
      });
      runIds.push(stream.run.id);

      const events = await collectEventsAndApproveActions(sdk, stream.events);
      const result = await stream.finalResult;

      await assertSuccessfulE2ERun({
        client: sdk,
        session: result.session,
        events,
        providerSource: "codex",
        runtimeKind: "codex",
        marker: "AR_CODEX_E2E_OK",
        createdPath: "reports/agent-smoke.txt",
        requiredEventTypes: [
          "run.claimed",
          "sandbox.created",
          "credential_boundary.verified",
          "action.proposed",
          "policy.evaluated",
          "approval.requested",
          "approval.decided",
          "execution.started",
          "execution.completed",
          "provider.stdout",
          "provider.stderr",
          "agent.response",
          "workspace.file_index_collected",
          "workspace.patch_collected",
          "run.completed"
        ],
        secretCanaries: [
          config.codexApiKey,
          config.daytonaApiKey,
          config.r2.secretAccessKey,
          config.r2.accessKeyId
        ]
      });

      const closeResult = await sdk.closeRun(stream.run.id);
      expect(closeResult).toMatchObject({
        closed: true,
        conversationId: stream.run.id,
        reclaimed: true
      });
      await expect(
        reapExpiredSandboxes({
          pool,
          schema,
          workerId: `worker_${randomUUID()}`,
          sandbox: new DaytonaSandboxDriver({
            apiKey: config.daytonaApiKey,
            testResourcePrefix: config.testResourcePrefix
          }),
          artifactStore,
          testResourcePrefix: config.testResourcePrefix,
          codexApiKey: config.codexApiKey,
          baseEnv: process.env
        })
      ).resolves.toBeGreaterThanOrEqual(1);
    } finally {
      controller.abort();
      await worker;
    }

    await expect(
      runOneWorkerIteration({
        pool,
        schema,
        workerId: `worker_${randomUUID()}`,
        sandbox: new DaytonaSandboxDriver({
          apiKey: config.daytonaApiKey,
          testResourcePrefix: config.testResourcePrefix
        }),
        artifactStore,
        testResourcePrefix: config.testResourcePrefix,
        codexApiKey: config.codexApiKey,
        baseEnv: process.env
      })
    ).resolves.toEqual({ processed: false });
  }, 600_000);

  it("streams no-progress signals from a real Codex run", async () => {
    const sdk = agentrouter({ baseUrl, apiKey: config.apiKey });
    const runtimeModel = process.env.AGENTROUTER_MODEL;
    const controller = new AbortController();
    const worker = runWorkerLoop({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: new DaytonaSandboxDriver({
        apiKey: config.daytonaApiKey,
        testResourcePrefix: config.testResourcePrefix
      }),
      artifactStore,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env,
      signal: controller.signal,
      pollIntervalMs: 250
    });

    try {
      const stream = await streamAgent({
        client: sdk,
        pollIntervalMs: 500,
        maxWaitMs: 10 * 60 * 1000,
        task:
          "Use the shell tool to run exactly this failing command three separate times without changing it: bash -lc 'echo AR_CODEX_LOOP && exit 1'. After the third failed attempt, run exactly: mkdir -p reports && printf 'AR_CODEX_NO_PROGRESS_E2E_OK\\n' > reports/no-progress.txt. Then summarize the change in one sentence.",
        approvalMode: "manual",
        runtime: codex({ mode: "full_access", ...(runtimeModel ? { model: runtimeModel } : {}) })
      });
      runIds.push(stream.run.id);

      const events = await collectEventsAndApproveActions(sdk, stream.events);
      const result = await stream.finalResult;

      await assertSuccessfulE2ERun({
        client: sdk,
        session: result.session,
        events,
        providerSource: "codex",
        runtimeKind: "codex",
        marker: "AR_CODEX_NO_PROGRESS_E2E_OK",
        createdPath: "reports/no-progress.txt",
        requiredEventTypes: [
          "run.claimed",
          "sandbox.created",
          "credential_boundary.verified",
          "action.proposed",
          "policy.evaluated",
          "approval.requested",
          "approval.decided",
          "execution.started",
          "agent.no_progress",
          "execution.completed",
          "provider.stdout",
          "provider.stderr",
          "agent.response",
          "workspace.file_index_collected",
          "workspace.patch_collected",
          "run.completed"
        ],
        secretCanaries: [
          config.codexApiKey,
          config.daytonaApiKey,
          config.r2.secretAccessKey,
          config.r2.accessKeyId
        ]
      });
      expect(events.find((event) => event.type === "agent.no_progress")?.payload).toMatchObject({
        provider: "codex",
        signal: "repeated_command"
      });

      const closeResult = await sdk.closeRun(stream.run.id);
      expect(closeResult).toMatchObject({
        closed: true,
        conversationId: stream.run.id,
        reclaimed: true
      });
    } finally {
      controller.abort();
      await worker;
    }
  }, 600_000);

  it("continues a real Codex conversation in the same sandbox and reclaims it", async () => {
    const sdk = agentrouter({ baseUrl, apiKey: config.apiKey });
    const runtimeModel = process.env.AGENTROUTER_MODEL;
    const controller = new AbortController();
    const worker = runWorkerLoop({
      pool,
      schema,
      workerId: `worker_${randomUUID()}`,
      sandbox: new DaytonaSandboxDriver({
        apiKey: config.daytonaApiKey,
        testResourcePrefix: config.testResourcePrefix
      }),
      artifactStore,
      testResourcePrefix: config.testResourcePrefix,
      codexApiKey: config.codexApiKey,
      baseEnv: process.env,
      signal: controller.signal,
      pollIntervalMs: 250
    });

    try {
      const first = await streamAgent({
        client: sdk,
        pollIntervalMs: 500,
        maxWaitMs: 10 * 60 * 1000,
        task:
          "Use the shell tool to run exactly: mkdir -p reports && printf 'AR_CODEX_TURN1_OK\\n' > reports/agent-smoke.txt. Then summarize the change in one sentence.",
        approvalMode: "manual",
        runtime: codex({ mode: "full_access", ...(runtimeModel ? { model: runtimeModel } : {}) })
      });
      runIds.push(first.run.id);

      const firstEvents = await collectEventsAndApproveActions(sdk, first.events);
      const firstResult = await first.finalResult;

      await assertSuccessfulE2ERun({
        client: sdk,
        session: firstResult.session,
        events: firstEvents,
        providerSource: "codex",
        runtimeKind: "codex",
        marker: "AR_CODEX_TURN1_OK",
        createdPath: "reports/agent-smoke.txt",
        requiredEventTypes: [
          "run.claimed",
          "sandbox.created",
          "credential_boundary.verified",
          "action.proposed",
          "policy.evaluated",
          "approval.requested",
          "approval.decided",
          "execution.started",
          "execution.completed",
          "provider.stdout",
          "provider.stderr",
          "agent.response",
          "workspace.file_index_collected",
          "workspace.patch_collected",
          "run.completed"
        ],
        secretCanaries: [
          config.codexApiKey,
          config.daytonaApiKey,
          config.r2.secretAccessKey,
          config.r2.accessKeyId
        ]
      });

      const second = await streamAgent({
        client: sdk,
        continueRun: firstResult.id,
        message:
          "Use the shell tool to run exactly: grep -qx 'AR_CODEX_TURN1_OK' reports/agent-smoke.txt && printf 'AR_CODEX_TURN2_OK\\n' > reports/turn2.txt. Then summarize the result in one sentence.",
        pollIntervalMs: 500,
        maxWaitMs: 10 * 60 * 1000
      });
      runIds.push(second.run.id);
      expect(second.conversationId).toBe(firstResult.id);
      expect(second.turnNumber).toBe(2);

      const secondEvents = await collectEventsAndApproveActions(sdk, second.events);
      const secondResult = await second.finalResult;

      await assertSuccessfulE2ERun({
        client: sdk,
        session: secondResult.session,
        events: secondEvents,
        providerSource: "codex",
        runtimeKind: "codex",
        marker: "AR_CODEX_TURN2_OK",
        createdPath: "reports/turn2.txt",
        sandboxLifecycleEventType: "sandbox.resumed",
        requiredEventTypes: [
          "run.claimed",
          "sandbox.resumed",
          "action.proposed",
          "policy.evaluated",
          "execution.started",
          "execution.completed",
          "provider.stdout",
          "provider.stderr",
          "agent.response",
          "workspace.file_index_collected",
          "workspace.patch_collected",
          "run.completed"
        ],
        secretCanaries: [
          config.codexApiKey,
          config.daytonaApiKey,
          config.r2.secretAccessKey,
          config.r2.accessKeyId
        ]
      });

      const turns = await sdk.getRunTurns(firstResult.id);
      expect(turns.conversationId).toBe(firstResult.id);
      expect(turns.items).toEqual([
        expect.objectContaining({
          runId: firstResult.id,
          turnNumber: 1
        }),
        expect.objectContaining({
          runId: second.run.id,
          turnNumber: 2,
          prompt: expect.stringContaining("AR_CODEX_TURN2_OK")
        })
      ]);

      const closeResult = await sdk.closeRun(firstResult.id);
      expect(closeResult).toMatchObject({
        closed: true,
        conversationId: firstResult.id,
        reclaimed: true
      });
      await expect(
        reapExpiredSandboxes({
          pool,
          schema,
          workerId: `worker_${randomUUID()}`,
          sandbox: new DaytonaSandboxDriver({
            apiKey: config.daytonaApiKey,
            testResourcePrefix: config.testResourcePrefix
          }),
          artifactStore,
          testResourcePrefix: config.testResourcePrefix,
          codexApiKey: config.codexApiKey,
          baseEnv: process.env
        })
      ).resolves.toBeGreaterThanOrEqual(1);
    } finally {
      controller.abort();
      await worker;
    }

    await expect(
      runOneWorkerIteration({
        pool,
        schema,
        workerId: `worker_${randomUUID()}`,
        sandbox: new DaytonaSandboxDriver({
          apiKey: config.daytonaApiKey,
          testResourcePrefix: config.testResourcePrefix
        }),
        artifactStore,
        testResourcePrefix: config.testResourcePrefix,
        codexApiKey: config.codexApiKey,
        baseEnv: process.env
      })
    ).resolves.toEqual({ processed: false });
  }, 900_000);
});
