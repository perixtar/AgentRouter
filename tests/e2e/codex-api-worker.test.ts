import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { agentrouter, codex, streamAgent, type RunEvent } from "agentrouter";
import { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { buildApiServer } from "@agentrouter/api";
import { parseAgentRouterEnv } from "@agentrouter/config";
import { applyPhase1Migrations, dropSchema } from "@agentrouter/db";
import { DaytonaSandboxDriver } from "@agentrouter/sandbox-daytona";
import { runOneWorkerIteration, runWorkerLoop } from "@agentrouter/worker";
import { assertSuccessfulE2ERun } from "./assertions.js";

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
        runtime: codex({ mode: "full_access", ...(runtimeModel ? { model: runtimeModel } : {}) })
      });
      runIds.push(stream.run.id);

      const events: RunEvent[] = [];
      for await (const event of stream.events) {
        events.push(event);
      }
      const result = await stream.finalResult;

      await assertSuccessfulE2ERun({
        client: sdk,
        session: result.session,
        events,
        providerSource: "codex",
        runtimeKind: "codex",
        marker: "AR_CODEX_E2E_OK",
        createdPath: "reports/agent-smoke.txt",
        secretCanaries: [
          config.codexApiKey,
          config.daytonaApiKey,
          config.r2.secretAccessKey,
          config.r2.accessKeyId
        ]
      });
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
});
