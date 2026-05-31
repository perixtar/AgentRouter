import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import {
  RunRepository,
  applyPhase1Migrations,
  dropSchema,
  quoteIdent,
  withSearchPath
} from "@agentrouter/db";
import { parseAgentRouterEnv } from "@agentrouter/config";

loadDotEnv();

describe("Phase 1 Postgres migrations", () => {
  it("creates the control-plane ledger and enforces bounded event rows", async () => {
    const config = parseAgentRouterEnv(process.env);
    const schema = `${config.testResourcePrefix}_${randomUUID().replaceAll("-", "_")}`;
    const pool = new Pool({ connectionString: config.databaseUrl });
    const client = await pool.connect();

    try {
      await applyPhase1Migrations(client, schema);
      await withSearchPath(client, schema, async () => {
        const columns = await client.query(
          `
            select column_name
            from information_schema.columns
            where table_schema = $1 and table_name = 'run_events'
            order by ordinal_position
          `,
          [schema]
        );

        expect(columns.rows.map((row) => row.column_name)).toContain("payload_size_bytes");
        expect(columns.rows.map((row) => row.column_name)).toContain("artifact_ref_json");

        const repo = new RunRepository(client);
        const run = await repo.createRun({
          id: `run_${randomUUID()}`,
          runtimeKind: "codex",
          runtimeMode: "default",
          input: { task: "hello" },
          promptSummary: "hello"
        });

        expect(run.status).toBe("queued");

        const event = await repo.appendEvent({
          runId: run.id,
          source: "worker",
          eventType: "run.started",
          visibility: "public",
          payload: { message: "started" }
        });

        expect(event.sequence).toBe(1n);

        await expect(
          client.query(
            `
              insert into run_events (
                run_id, sequence, source, event_type, visibility,
                payload_json, payload_size_bytes
              )
              values ($1, 2, 'worker', 'oversized', 'public', $2::jsonb, 40000)
            `,
            [run.id, JSON.stringify({ text: "x" })]
          )
        ).rejects.toThrow();
      });
    } finally {
      await dropSchema(client, schema);
      client.release();
      await pool.end();
    }

    expect(quoteIdent(schema)).toBe(`"${schema}"`);
  });
});
