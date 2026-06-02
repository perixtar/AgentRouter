import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import {
  RunRepository,
  applyPhase1Migrations,
  dropSchema,
  quoteIdent,
  quoteLiteral,
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
        const runConstraints = await client.query(
          `
            select conname
            from pg_constraint
            where conrelid = 'runs'::regclass and contype = 'c'
          `
        );
        const attemptConstraints = await client.query(
          `
            select conname
            from pg_constraint
            where conrelid = 'run_attempts'::regclass and contype = 'c'
          `
        );

        expect(runConstraints.rows.map((row) => row.conname)).toContain(
          "runs_runtime_kind_mode_check"
        );
        expect(attemptConstraints.rows.map((row) => row.conname)).toContain(
          "run_attempts_runtime_kind_mode_check"
        );

        const repo = new RunRepository(client);
        const run = await repo.createRun({
          id: `run_${randomUUID()}`,
          orgId: "org_test",
          runtimeKind: "codex",
          runtimeMode: "default",
          runtimeModel: "gpt-4o",
          input: { task: "hello" },
          promptSummary: "hello"
        });

        expect(run.status).toBe("queued");
        expect(run.runtimeModel).toBe("gpt-4o");

        await expect(
          repo.createRun({
            id: `run_${randomUUID()}`,
            orgId: "org_test",
            runtimeKind: "claude_code",
            runtimeMode: "acceptEdits",
            runtimeModel: "claude-sonnet-4-6",
            input: { task: "hello from claude" },
            promptSummary: "hello from claude"
          })
        ).resolves.toMatchObject({
          runtimeKind: "claude_code",
          runtimeMode: "acceptEdits",
          runtimeModel: "claude-sonnet-4-6"
        });

        await expect(
          repo.createRun({
            id: `run_${randomUUID()}`,
            orgId: "org_test",
            runtimeKind: "claude_code",
            runtimeMode: "full_access",
            input: { task: "invalid" },
            promptSummary: "invalid"
          })
        ).rejects.toThrow();

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
    expect(quoteLiteral("agent's model")).toBe("'agent''s model'");
  });
});
