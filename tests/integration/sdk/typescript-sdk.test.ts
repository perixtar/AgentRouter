import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { AgentRouter } from "@agentrouter/sdk";
import { buildApiServer } from "@agentrouter/api";
import { parseAgentRouterEnv } from "@agentrouter/config";
import {
  RunRepository,
  applyPhase1Migrations,
  dropSchema,
  withSearchPath
} from "@agentrouter/db";

loadDotEnv();

describe("AgentRouter TypeScript SDK", () => {
  const config = parseAgentRouterEnv(process.env);
  const schema = `${config.testResourcePrefix}_${randomUUID().replaceAll("-", "_")}`;
  const pool = new Pool({ connectionString: config.databaseUrl });
  const server = buildApiServer({
    pool,
    schema,
    apiKey: config.apiKey
  });

  let baseUrl = "";

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
    const client = await pool.connect();
    try {
      await dropSchema(client, schema);
    } finally {
      client.release();
      await server.close();
      await pool.end();
    }
  });

  it("creates, restores, streams, waits, and cancels with a small ergonomic API", async () => {
    const sdk = new AgentRouter({
      baseUrl,
      apiKey: config.apiKey
    });

    const run = await sdk.runs.create({
      task: "Summarize this repo",
      runtime: { kind: "codex", mode: "default" }
    });

    expect(run.status).toBe("queued");

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.appendEvent({
          runId: run.id,
          source: "worker",
          eventType: "run.completed",
          visibility: "public",
          payload: { message: "done" }
        });
        await repo.updateRunStatus(run.id, "starting");
        await repo.updateRunStatus(run.id, "running");
        await repo.updateRunStatus(run.id, "completed");
      });
    } finally {
      client.release();
    }

    const restored = await sdk.runs.session(run.id);
    expect(restored.run.status).toBe("completed");
    expect(restored.eventCursor.lastEventSeq).toBe(1);

    const events = [];
    for await (const event of sdk.runs.stream(run.id)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run.completed" });

    await expect(
      sdk.runs.createAndWait({
        task: "Summarize again",
        runtime: { kind: "codex", mode: "default" },
        pollIntervalMs: 1,
        maxWaitMs: 1
      })
    ).rejects.toMatchObject({
      code: "wait_timeout"
    });

    const cancelling = await sdk.runs.cancel(run.id);
    expect(cancelling.status).toBe("completed");
  });
});
