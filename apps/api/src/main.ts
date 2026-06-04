import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { parseAgentRouterEnv } from "@agentrouter/config";
import { applyPhase1Migrations } from "@agentrouter/db";
import { buildApiServer } from "./server.js";

loadDotEnv();

const config = parseAgentRouterEnv(process.env);
const pool = new Pool({ connectionString: config.databaseUrl });
const schema = process.env.AGENTROUTER_DB_SCHEMA ?? "public";
const port = Number.parseInt(process.env.AGENTROUTER_PORT ?? "8787", 10);

const client = await pool.connect();
try {
  await applyPhase1Migrations(client, schema);
} finally {
  client.release();
}

const server = buildApiServer({
  pool,
  schema,
  apiKey: config.apiKey,
  // Optional managed-cloud org-assertion token. Unset → single-tenant default.
  webServiceToken: process.env.AGENTROUTER_WEB_SERVICE_TOKEN,
  artifactBytes: new R2ArtifactStore(config.r2)
});

await server.listen({ port, host: "0.0.0.0" });
console.log(`AgentRouter API listening on http://127.0.0.1:${port}`);
