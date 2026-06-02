import { randomUUID } from "node:crypto";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { parseAgentRouterEnv } from "@agentrouter/config";
import { applyPhase1Migrations } from "@agentrouter/db";
import { DaytonaSandboxDriver } from "@agentrouter/sandbox-daytona";
import { runOneWorkerIteration, runWorkerLoop } from "@agentrouter/worker";

loadDotEnv();

const config = parseAgentRouterEnv(process.env);
const pool = new Pool({ connectionString: config.databaseUrl });
const schema = process.env.AGENTROUTER_DB_SCHEMA ?? "public";
const workerId = process.env.AGENTROUTER_WORKER_ID ?? `worker_${randomUUID()}`;

const client = await pool.connect();
try {
  await applyPhase1Migrations(client, schema);
} finally {
  client.release();
}

const workerInput = {
  pool,
  schema,
  workerId,
  sandbox: new DaytonaSandboxDriver({
    apiKey: config.daytonaApiKey,
    testResourcePrefix: config.testResourcePrefix
  }),
  artifactStore: new R2ArtifactStore(config.r2),
  testResourcePrefix: config.testResourcePrefix,
  codexApiKey: config.codexApiKey,
  anthropicApiKey: config.anthropicApiKey,
  masterKey: config.masterKey,
  // Multi-turn run lifecycle / sandbox reclaim TTLs (env-tunable via config).
  oneShotGraceMinutes: config.oneShotGraceMinutes,
  sessionIdleTtlMinutes: config.sessionIdleTtlMinutes,
  sessionAutoStopMinutes: config.sessionAutoStopMinutes,
  sessionAutoDeleteMinutes: config.sessionAutoDeleteMinutes,
  baseEnv: process.env
};

if (process.env.AGENTROUTER_WORKER_RUN_ONCE === "1") {
  const result = await runOneWorkerIteration(workerInput);
  await pool.end();
  console.log(JSON.stringify(result));
} else {
  console.log(`AgentRouter worker ${workerId} polling schema ${schema}`);
  await runWorkerLoop({
    ...workerInput,
    pollIntervalMs: Number.parseInt(process.env.AGENTROUTER_WORKER_POLL_INTERVAL_MS ?? "1000", 10),
    reaperIntervalSeconds: config.reaperIntervalSeconds,
    onIteration(result) {
      if (result.processed) {
        console.log(JSON.stringify(result));
      }
    },
    onReap(count) {
      console.log(JSON.stringify({ reaped: count }));
    }
  });
}
