import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { agentrouter, codex, runAgent, streamAgent } from "@agentrouter/sdk";
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
    const sdk = agentrouter({
      baseUrl,
      apiKey: config.apiKey
    });

    const run = await sdk.createRun({
      task: "Summarize this repo",
      runtime: codex({ mode: "default", model: "gpt-4o" })
    });

    expect(run.status).toBe("queued");
    expect(run.runtime).toMatchObject({ kind: "codex", mode: "default", model: "gpt-4o" });

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

    const restored = await sdk.getRunSession(run.id);
    expect(restored.run.status).toBe("completed");
    expect(restored.eventCursor.lastEventSeq).toBe(1);

    const events = [];
    for await (const event of sdk.streamRun(run.id)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run.completed" });

    await expect(
      runAgent({
        client: sdk,
        sessionId: run.id,
        afterSeq: 0,
        pollIntervalMs: 1,
        maxWaitMs: 100,
        onEvent: (event) => events.push(event)
      })
    ).resolves.toMatchObject({
      run: { id: run.id, status: "completed" },
      eventCursor: { lastEventSeq: 1 }
    });

    await expect(
      runAgent({
        client: sdk,
        task: "Summarize again",
        runtime: codex({ mode: "default", model: "gpt-4o" }),
        pollIntervalMs: 1,
        maxWaitMs: 1
      })
    ).rejects.toMatchObject({
      code: "wait_timeout"
    });

    const cancelling = await sdk.cancelRun(run.id);
    expect(cancelling.status).toBe("completed");
  });

  it("streams events from streamAgent until the run is terminal", async () => {
    const sdk = agentrouter({
      baseUrl,
      apiKey: config.apiKey
    });

    const stream = await streamAgent({
      client: sdk,
      task: "Stream this repo summary",
      runtime: codex({ mode: "default", model: "gpt-4o" }),
      pollIntervalMs: 1,
      maxWaitMs: 1000
    });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.appendEvent({
          runId: stream.run.id,
          source: "worker",
          eventType: "run.completed",
          visibility: "public",
          payload: { message: "streamed" }
        });
        await repo.updateRunStatus(stream.run.id, "starting");
        await repo.updateRunStatus(stream.run.id, "running");
        await repo.updateRunStatus(stream.run.id, "completed");
      });
    } finally {
      client.release();
    }

    const events = [];
    for await (const event of stream.events) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "run.completed" });
    await expect(stream.finalSession).resolves.toMatchObject({
      run: { id: stream.run.id, status: "completed" }
    });
  });

  it("does not export a separate resumeRun helper", async () => {
    const sdkModule = await import("@agentrouter/sdk");

    expect(sdkModule).not.toHaveProperty("resumeRun");
  });
});
