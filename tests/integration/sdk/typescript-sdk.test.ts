import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { agentrouter, claudeCode, codex, runAgent, streamAgent } from "@agentrouterhq/sdk";
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
          eventType: "agent.response",
          visibility: "public",
          payload: {
            text: "SDK final answer",
            parts: [{ type: "text", text: "SDK final answer" }],
            provider: "codex"
          }
        });
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
    expect(restored.eventCursor.lastEventSeq).toBe(2);
    expect(restored.response?.text).toBe("SDK final answer");

    const events = [];
    for await (const event of sdk.streamRun(run.id)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "agent.response" });
    expect(events[1]).toMatchObject({ type: "run.completed" });

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

  it("continueRun resolves the conversation by run id and enqueues a new turn", async () => {
    const sdk = agentrouter({ baseUrl, apiKey: config.apiKey });

    // Turn 1: create a run and (simulating the worker grace-park) promote it to
    // a conversation keyed by its run id.
    const run = await sdk.createRun({
      task: "write fib.py",
      runtime: codex({ mode: "full_access" })
    });
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.updateRunStatus(run.id, "starting");
        await repo.updateRunStatus(run.id, "running");
        await repo.updateRunStatus(run.id, "completed");
        await repo.promoteRunToSession({
          sessionId: `sess_${randomUUID()}`,
          runId: run.id,
          orgId: "org_system",
          runtimeKind: "codex",
          runtimeMode: "full_access",
          prompt: "write fib.py",
          sandboxId: `sandbox_${randomUUID()}`,
          codexSessionId: "thread_xyz",
          sandboxState: "suspended",
          idleDeadlineAt: new Date(Date.now() + 10 * 60_000)
        });
      });
    } finally {
      client.release();
    }

    // continueRun by the FIRST run id → a brand-new turn-2 run.
    const continued = await sdk.continueRun(run.id, "now add a test");
    expect(continued.turnNumber).toBe(2);
    expect(continued.conversationId).toBe(run.id); // handle = first run id
    expect(continued.runId).not.toBe(run.id);

    // getRunTurns lists both turns of the conversation.
    const turns = await sdk.getRunTurns(run.id);
    expect(turns.conversationId).toBe(run.id);
    expect(turns.items.map((t) => t.turnNumber)).toEqual([1, 2]);
    expect(turns.items.map((t) => t.runId)).toEqual([run.id, continued.runId]);

    // runAgent({ continueRun, message }) actually CONTINUES (sends the message,
    // then waits the new turn). Simulate the worker finishing turn 3.
    const completeNextTurn = async (turnRunId: string, text: string) => {
      const c = await pool.connect();
      try {
        await withSearchPath(c, schema, async () => {
          const repo = new RunRepository(c);
          await repo.appendEvent({
            runId: turnRunId,
            source: "worker",
            eventType: "agent.response",
            visibility: "public",
            payload: { text, parts: [{ type: "text", text }], provider: "codex" }
          });
          await repo.appendEvent({
            runId: turnRunId,
            source: "worker",
            eventType: "run.completed",
            visibility: "public",
            payload: { message: "done" }
          });
          await repo.updateRunStatus(turnRunId, "starting");
          await repo.updateRunStatus(turnRunId, "running");
          await repo.updateRunStatus(turnRunId, "completed");
        });
      } finally {
        c.release();
      }
    };

    // Mark turn 2 complete so the conversation is idle again, then runAgent-continue.
    await completeNextTurn(continued.runId, "added test_fib.py");

    // Fire runAgent (which enqueues turn 3), grab its run id, complete it, await.
    let turn3RunId = "";
    const resumePromise = runAgent({
      client: sdk,
      continueRun: run.id,
      message: "now add a docstring",
      pollIntervalMs: 5,
      maxWaitMs: 5_000
    });
    // Poll for turn 3's run id, then simulate the worker completing it.
    for (let i = 0; i < 100 && !turn3RunId; i++) {
      const t = await sdk.getRunTurns(run.id);
      const turn3 = t.items.find((x) => x.turnNumber === 3);
      if (turn3) turn3RunId = turn3.runId;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(turn3RunId).not.toBe("");
    await completeNextTurn(turn3RunId, "added docstring");

    const result = await resumePromise;
    expect(result.run.id).toBe(turn3RunId); // resumed the NEW turn, not the old run
    expect(result.status).toBe("completed");
    expect(result.text).toBe("added docstring");

    // streamAgent also continues conversations; no separate continueAgent helper.
    let turn4RunId = "";
    const stream = await streamAgent({
      client: sdk,
      continueRun: run.id,
      message: "now add a README note",
      pollIntervalMs: 5,
      maxWaitMs: 5_000
    });
    for (let i = 0; i < 100 && !turn4RunId; i++) {
      const t = await sdk.getRunTurns(run.id);
      const turn4 = t.items.find((x) => x.turnNumber === 4);
      if (turn4) turn4RunId = turn4.runId;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(turn4RunId).not.toBe("");
    expect(stream.run.id).toBe(turn4RunId);
    expect(stream.conversationId).toBe(run.id);
    expect(stream.turnNumber).toBe(4);
    await completeNextTurn(turn4RunId, "added README note");

    const streamedText: string[] = [];
    for await (const text of stream.textStream) {
      streamedText.push(text);
    }
    expect(streamedText).toEqual(["added README note"]);
    await expect(stream.finalResult).resolves.toMatchObject({
      run: { id: turn4RunId, status: "completed" },
      text: "added README note"
    });
  });

  it("sends configured default headers", async () => {
    const seen: Array<Record<string, string>> = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return fetch(input as RequestInfo, init);
    };
    const sdk = agentrouter({
      baseUrl,
      apiKey: config.apiKey,
      defaultHeaders: { "x-agentrouter-test": "yes" },
      fetchImpl: recordingFetch
    });
    await sdk.listRuns({ limit: 1 });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.["x-agentrouter-test"]).toBe("yes");
  });

  it("closeRun closes a conversation by run id", async () => {
    const sdk = agentrouter({ baseUrl, apiKey: config.apiKey });
    const run = await sdk.createRun({
      task: "write thing.py",
      runtime: codex({ mode: "full_access" })
    });
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.updateRunStatus(run.id, "starting");
        await repo.updateRunStatus(run.id, "running");
        await repo.updateRunStatus(run.id, "completed");
        await repo.promoteRunToSession({
          sessionId: `sess_${randomUUID()}`,
          runId: run.id,
          orgId: "org_system",
          runtimeKind: "codex",
          runtimeMode: "full_access",
          prompt: "write thing.py",
          sandboxId: `sandbox_${randomUUID()}`,
          sandboxState: "suspended",
          idleDeadlineAt: new Date(Date.now() + 10 * 60_000)
        });
      });
    } finally {
      client.release();
    }

    const closed = await sdk.closeRun(run.id);
    expect(closed).toMatchObject({ closed: true, conversationId: run.id, reclaimed: true });
  });

  it("retries closeRun while a completed continuable Codex run is still being promoted", async () => {
    const runId = "run_close_promote_race";
    let closeAttempts = 0;
    const sdk = agentrouter({
      baseUrl: "https://agentrouter.test",
      apiKey: "ar_test",
      fetchImpl: async (input) => {
        const url = new URL(String(input));

        if (url.pathname === `/v1/runs/${runId}/close`) {
          closeAttempts += 1;
          return jsonResponse({
            closed: true,
            conversationId: runId,
            reclaimed: closeAttempts > 1
          });
        }

        if (url.pathname === `/v1/runs/${runId}`) {
          return jsonResponse({
            id: runId,
            status: "completed",
            runtime: { kind: "codex", mode: "full_access" },
            task: "race",
            input: {},
            lastEventSeq: 10,
            queuedAt: new Date(0).toISOString(),
            completedAt: new Date(1).toISOString()
          });
        }

        throw new Error(`Unexpected SDK request: GET ${url.pathname}`);
      }
    });

    await expect(sdk.closeRun(runId)).resolves.toMatchObject({
      closed: true,
      conversationId: runId,
      reclaimed: true
    });
    expect(closeAttempts).toBe(2);
  });

  it("rejects continuing a non-promoted run with run_not_continuable", async () => {
    const sdk = agentrouter({ baseUrl, apiKey: config.apiKey });
    const run = await sdk.createRun({
      task: "one-shot only",
      runtime: codex({ mode: "full_access" })
    });
    await expect(sdk.continueRun(run.id, "continue please")).rejects.toMatchObject({
      code: "run_not_continuable",
      statusCode: 409
    });
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
      maxWaitMs: 10_000
    });

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.appendEvent({
          runId: stream.run.id,
          source: "worker",
          eventType: "agent.progress",
          visibility: "public",
          payload: {
            summary: "Inspected the repository before answering",
            provider: "codex"
          }
        });
        await repo.appendEvent({
          runId: stream.run.id,
          source: "worker",
          eventType: "agent.response",
          visibility: "public",
          payload: {
            text: "streamed final answer",
            parts: [{ type: "text", text: "streamed final answer" }],
            provider: "codex"
          }
        });
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

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "agent.progress" });
    expect(events[1]).toMatchObject({ type: "agent.response" });
    expect(events[2]).toMatchObject({ type: "run.completed" });

    const streamParts = [];
    for await (const part of stream.fullStream) {
      streamParts.push(part);
    }
    expect(streamParts).toEqual([
      expect.objectContaining({
        type: "progress",
        text: "Inspected the repository before answering"
      }),
      expect.objectContaining({
        type: "text",
        text: "streamed final answer"
      }),
      expect.objectContaining({
        type: "done",
        status: "completed"
      })
    ]);

    const textParts: string[] = [];
    for await (const textPart of stream.textStream) {
      textParts.push(textPart);
    }
    expect(textParts).toEqual(["streamed final answer"]);

    await expect(stream.finalResult).resolves.toMatchObject({
      run: { id: stream.run.id, status: "completed" },
      text: "streamed final answer"
    });
  });

  it("drains events up to terminal lastEventSeq before ending a stream", async () => {
    const runId = "run_stream_terminal_race";
    const eventPageRequests: number[] = [];
    const sdk = agentrouter({
      baseUrl: "https://agentrouter.test",
      apiKey: "ar_test",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));

        if (url.pathname === "/v1/runs" && init?.method === "POST") {
          return jsonResponse({
            id: runId,
            status: "queued",
            runtime: { kind: "codex", mode: "default" },
            task: "race",
            input: {},
            lastEventSeq: 0,
            queuedAt: new Date(0).toISOString()
          });
        }

        if (url.pathname === `/v1/runs/${runId}/events`) {
          const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
          eventPageRequests.push(afterSeq);
          return jsonResponse({
            items:
              afterSeq === 0
                ? [
                    runEvent(runId, 1, "agent.progress", { summary: "started" }),
                    runEvent(runId, 2, "agent.response", {
                      text: "answer",
                      parts: [{ type: "text", text: "answer" }],
                      provider: "codex"
                    })
                  ]
                : [runEvent(runId, 3, "run.completed", { message: "completed" })],
            nextAfterSeq: afterSeq === 0 ? 2 : 3
          });
        }

        if (url.pathname === `/v1/runs/${runId}/session`) {
          return jsonResponse({
            run: {
              id: runId,
              status: "completed",
              runtime: { kind: "codex", mode: "default" },
              task: "race",
              input: {},
              lastEventSeq: 3,
              queuedAt: new Date(0).toISOString(),
              completedAt: new Date(1).toISOString()
            },
            eventCursor: { lastEventSeq: 3 },
            response: {
              text: "answer",
              parts: [{ type: "text", text: "answer" }],
              provider: "codex"
            },
            artifactManifest: { status: "missing" },
            artifacts: { items: [] }
          });
        }

        if (url.pathname === `/v1/runs/${runId}`) {
          return jsonResponse({
            id: runId,
            status: "completed",
            runtime: { kind: "codex", mode: "default" },
            task: "race",
            input: {},
            lastEventSeq: 3,
            queuedAt: new Date(0).toISOString(),
            completedAt: new Date(1).toISOString()
          });
        }

        throw new Error(`Unexpected SDK request: ${init?.method ?? "GET"} ${url.pathname}`);
      }
    });

    const stream = await streamAgent({
      client: sdk,
      task: "race",
      runtime: codex(),
      pollIntervalMs: 1,
      maxWaitMs: 1000
    });

    const events = [];
    for await (const event of stream.events) {
      events.push(event);
    }
    await expect(stream.finalResult).resolves.toMatchObject({ id: runId, status: "completed" });

    expect(eventPageRequests).toContain(2);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed" });
  });

  it("creates Claude Code runs through the same SDK client", async () => {
    const sdk = agentrouter({
      baseUrl,
      apiKey: config.apiKey
    });

    const run = await sdk.createRun({
      task: "Create reports/claude-sdk.txt",
      runtime: claudeCode({ permissionMode: "acceptEdits", model: "claude-sonnet-4-6" })
    });

    expect(run.status).toBe("queued");
    expect(run.runtime).toMatchObject({
      kind: "claude_code",
      permissionMode: "acceptEdits",
      model: "claude-sonnet-4-6"
    });
  });

  it("does not export a separate resumeRun helper", async () => {
    const sdkModule = await import("@agentrouterhq/sdk");

    expect(sdkModule).not.toHaveProperty("resumeRun");
  });

  it("exposes only run-id multi-turn SDK helpers", async () => {
    const sdkModule = await import("@agentrouterhq/sdk");
    const sdk = agentrouter({ baseUrl, apiKey: config.apiKey });

    // Client methods exist.
    expect(typeof sdk.continueRun).toBe("function");
    expect(typeof sdk.getRunTurns).toBe("function");
    expect(typeof sdk.closeRun).toBe("function");
    // Top-level continuation is handled by runAgent/streamAgent, not a
    // separate continueAgent helper.
    expect(sdkModule).not.toHaveProperty("continueAgent");
    // Deprecated session endpoints are not part of the public SDK surface.
    expect(sdk).not.toHaveProperty("createSession");
    expect(sdk).not.toHaveProperty("getSession");
    expect(sdk).not.toHaveProperty("sendMessage");
    expect(sdk).not.toHaveProperty("listSessionEvents");
    expect(sdk).not.toHaveProperty("streamSession");
    expect(sdk).not.toHaveProperty("closeSession");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function runEvent(
  runId: string,
  sequence: number,
  type: string,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    runId,
    sequence,
    type,
    source: "worker",
    visibility: "public",
    payload,
    isTruncated: false,
    createdAt: new Date(sequence).toISOString()
  };
}
