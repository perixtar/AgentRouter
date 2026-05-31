import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { AgentRouter } from "@agentrouter/sdk";
import { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { buildApiServer } from "@agentrouter/api";
import { parseAgentRouterEnv } from "@agentrouter/config";
import { applyPhase1Migrations, dropSchema } from "@agentrouter/db";
import { DaytonaSandboxDriver } from "@agentrouter/sandbox-daytona";
import { runOneWorkerIteration } from "@agentrouter/worker";

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
  let runId = "";

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
    if (runId) {
      await artifactStore.deleteRunPrefix(runId);
    }

    const client = await pool.connect();
    try {
      await dropSchema(client, schema);
    } finally {
      client.release();
      await server.close();
      await pool.end();
    }
  });

  it("creates a run through the SDK and completes it through a real Daytona sandbox and Codex CLI", async () => {
    const sdk = new AgentRouter({ baseUrl, apiKey: config.apiKey });
    const run = await sdk.runs.create({
      task:
        "Use the shell tool to run exactly: mkdir -p reports && printf 'AR_CODEX_E2E_OK\\n' > reports/agent-smoke.txt. Then summarize the change in one sentence.",
      runtime: { kind: "codex", mode: "full_access" },
      source: { type: "scratch" }
    });
    runId = run.id;

    const result = await runOneWorkerIteration({
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
    });

    expect(result).toEqual({ processed: true, runId });

    const session = await sdk.runs.session(runId);
    expect(session.run.status).toBe("completed");
    expect(session.artifactManifest.status).toBe("available");
    expect(session.artifacts.items.map((artifact) => artifact.kind)).toContain("workspace_file_index");
    expect(session.artifacts.items.map((artifact) => artifact.kind)).toContain("workspace_patch");

    const patch = session.artifacts.items.find((artifact) => artifact.kind === "workspace_patch");
    expect(patch).toBeDefined();
    const patchBytes = await sdk.runs.downloadArtifact(runId, patch!.id);
    expect(Buffer.from(patchBytes).toString("utf8")).toContain("AR_CODEX_E2E_OK");
  }, 600_000);
});
