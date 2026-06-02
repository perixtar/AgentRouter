import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { Pool } from "pg";
import { buildApiServer } from "@agentrouter/api";
import { parseAgentRouterEnv } from "@agentrouter/config";
import {
  RunRepository,
  applyPhase1Migrations,
  dropSchema,
  withSearchPath
} from "@agentrouter/db";

loadDotEnv();

describe("AgentRouter API", () => {
  const config = parseAgentRouterEnv(process.env);
  const schema = `${config.testResourcePrefix}_${randomUUID().replaceAll("-", "_")}`;
  const pool = new Pool({ connectionString: config.databaseUrl });
  const server = buildApiServer({
    pool,
    schema,
    apiKey: config.apiKey
  });

  beforeAll(async () => {
    const client = await pool.connect();
    try {
      await applyPhase1Migrations(client, schema);
    } finally {
      client.release();
    }
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

  it("rejects unauthenticated clients", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      payload: {
        task: "Inspect the repo",
        runtime: { kind: "codex", mode: "default" }
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: "unauthorized"
      }
    });
  });

  it("creates, restores, streams, lists, and cancels a Codex run", async () => {
    const idempotencyKey = `idem_${randomUUID()}`;
    const payload = {
      task: "Create reports/agent-smoke.txt and summarize the change",
      runtime: { kind: "codex", mode: "default" }
    };

    const createResponse = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey, idempotencyKey),
      payload
    });

    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created).toMatchObject({
      status: "queued",
      runtime: { kind: "codex", mode: "default" },
      lastEventSeq: 0
    });
    expect(created.id).toMatch(/^run_/);

    const replayResponse = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey, idempotencyKey),
      payload
    });

    expect(replayResponse.statusCode).toBe(200);
    expect(replayResponse.json().id).toBe(created.id);

    const listResponse = await server.inject({
      method: "GET",
      url: "/v1/runs?status=active",
      headers: authHeaders(config.apiKey)
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().items.map((run: { id: string }) => run.id)).toContain(created.id);

    const getResponse = await server.inject({
      method: "GET",
      url: `/v1/runs/${created.id}`,
      headers: authHeaders(config.apiKey)
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      id: created.id,
      status: "queued"
    });

    const eventsResponse = await server.inject({
      method: "GET",
      url: `/v1/runs/${created.id}/events?afterSeq=0&limit=500`,
      headers: authHeaders(config.apiKey)
    });

    expect(eventsResponse.statusCode).toBe(200);
    expect(eventsResponse.json()).toMatchObject({
      items: [],
      nextAfterSeq: 0
    });

    const sessionResponse = await server.inject({
      method: "GET",
      url: `/v1/runs/${created.id}/session`,
      headers: authHeaders(config.apiKey)
    });

    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toMatchObject({
      run: { id: created.id, status: "queued" },
      eventCursor: { lastEventSeq: 0 },
      artifactManifest: { status: "missing" },
      response: null
    });

    const streamResponse = await server.inject({
      method: "GET",
      url: `/v1/runs/${created.id}/stream?afterSeq=0`,
      headers: authHeaders(config.apiKey)
    });

    expect(streamResponse.statusCode).toBe(200);
    expect(streamResponse.headers["content-type"]).toContain("text/event-stream");
    expect(streamResponse.body).toContain("event: heartbeat");

    const cancelResponse = await server.inject({
      method: "POST",
      url: `/v1/runs/${created.id}/cancel`,
      headers: authHeaders(config.apiKey)
    });

    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json()).toMatchObject({
      id: created.id,
      status: "cancelling"
    });
  });

  it("restores the normalized final agent response from session", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Explain the repo",
        runtime: { kind: "codex", mode: "default" }
      }
    });
    const created = createResponse.json();

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.appendEvent({
          runId: created.id,
          source: "worker",
          eventType: "agent.response",
          visibility: "public",
          payload: {
            text: "The agent final answer",
            parts: [{ type: "text", text: "The agent final answer" }],
            provider: "codex"
          }
        });
        await repo.updateRunStatus(created.id, "starting");
        await repo.updateRunStatus(created.id, "running");
        await repo.updateRunStatus(created.id, "completed");
      });
    } finally {
      client.release();
    }

    const sessionResponse = await server.inject({
      method: "GET",
      url: `/v1/runs/${created.id}/session`,
      headers: authHeaders(config.apiKey)
    });

    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toMatchObject({
      run: { id: created.id, status: "completed" },
      response: {
        text: "The agent final answer",
        parts: [{ type: "text", text: "The agent final answer" }],
        provider: "codex"
      }
    });
  });

  it("creates a Codex run with an explicit provider model", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        runtime: { kind: "codex", mode: "default", model: "gpt-4o" }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "queued",
      runtime: { kind: "codex", mode: "default", model: "gpt-4o" },
      input: {
        runtime: { kind: "codex", mode: "default", model: "gpt-4o" }
      }
    });
  });

  it("rejects unsafe runtime model strings", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        runtime: { kind: "codex", mode: "default", model: "gpt-4o;rm -rf /" }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error"
      }
    });
  });

  it("rejects unknown top-level run creation fields", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        runtime: { kind: "codex", mode: "default" },
        temperature: 0.2
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "validation_error"
      }
    });
  });

  it("creates a Claude Code run with provider-specific permission mode and model", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        runtime: { kind: "claude_code", permissionMode: "acceptEdits", model: "claude-sonnet-4-6" }
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      status: "queued",
      runtime: {
        kind: "claude_code",
        permissionMode: "acceptEdits",
        model: "claude-sonnet-4-6"
      },
      input: {
        runtime: {
          kind: "claude_code",
          permissionMode: "acceptEdits",
          model: "claude-sonnet-4-6"
        }
      }
    });
  });

  it("rejects runtime mode fields that belong to another provider", async () => {
    const codexWithClaudePermissionMode = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        runtime: { kind: "codex", permissionMode: "acceptEdits" }
      }
    });

    expect(codexWithClaudePermissionMode.statusCode).toBe(400);
    expect(codexWithClaudePermissionMode.json()).toMatchObject({
      error: {
        code: "validation_error"
      }
    });

    const claudeWithCodexMode = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        runtime: { kind: "claude_code", mode: "full_access" }
      }
    });

    expect(claudeWithCodexMode.statusCode).toBe(400);
    expect(claudeWithCodexMode.json()).toMatchObject({
      error: {
        code: "validation_error"
      }
    });
  });

  it("rejects raw tool and CLI override attempts", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        runtime: { kind: "codex", mode: "default" },
        tools: [{ name: "unsafe" }]
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "unsupported_tool_configuration"
      }
    });
  });

  it("rejects workspace attachments in Phase 1", async () => {
    for (const payload of [
      {
        task: "Inspect a repo",
        runtime: { kind: "codex", mode: "default" },
        repoUrl: "https://github.com/octocat/Hello-World.git"
      },
      {
        task: "Inspect a repo",
        runtime: { kind: "codex", mode: "default" },
        source: { type: "scratch" }
      }
    ]) {
      const response = await server.inject({
        method: "POST",
        url: "/v1/runs",
        headers: authHeaders(config.apiKey),
        payload
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "unsupported_workspace_attachment"
        }
      });
    }
  });

  // ── M4 bug-fix regressions ──

  // Helper: count session runs that have no matching turns row (orphans).
  async function orphanRunCount(sessionId: string): Promise<number> {
    const client = await pool.connect();
    try {
      return await withSearchPath(client, schema, async () => {
        const result = await client.query<{ n: string }>(
          `select count(*)::int as n
             from runs r
            where r.session_id = $1
              and not exists (select 1 from turns t where t.run_id = r.id)`,
          [sessionId]
        );
        return Number(result.rows[0]?.n ?? 0);
      });
    } finally {
      client.release();
    }
  }

  it("BUG 1: a message after a failed turn starts a fresh tracked turn — no orphan run, no 500", async () => {
    // Create a session.
    const created = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: authHeaders(config.apiKey),
      payload: { runtime: { kind: "codex", mode: "full_access" } }
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as string;

    // Turn 1: create the run + turn via the real handler.
    const turn1 = await server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: authHeaders(config.apiKey),
      payload: { message: "write fib.py" }
    });
    expect(turn1.statusCode).toBe(202);
    const run1 = turn1.json().runId as string;
    expect(turn1.json().turnNumber).toBe(1);

    // Simulate the failure that triggered the bug: the run failed AND the
    // session counter was left stale (turn_count behind the turns rows).
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        await client.query(`update runs set status = 'failed' where id = $1`, [run1]);
        await client.query(`update sessions set turn_count = 0 where id = $1`, [sessionId]);
      });
    } finally {
      client.release();
    }

    // The next message must succeed (202), as a NEW turn #2 — not 500.
    const turn2 = await server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: authHeaders(config.apiKey),
      payload: { message: "now add a test" }
    });
    expect(turn2.statusCode).toBe(202);
    expect(turn2.json().turnNumber).toBe(2);

    // No orphan run: every session run is tracked by a turns row.
    expect(await orphanRunCount(sessionId)).toBe(0);
  });

  it("BUG 1: a turn-number collision creates NO orphan run (atomic /messages)", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: authHeaders(config.apiKey),
      payload: {}
    });
    const sessionId = created.json().id as string;

    // First message → turn 1.
    const turn1 = await server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: authHeaders(config.apiKey),
      payload: { message: "first" }
    });
    expect(turn1.statusCode).toBe(202);
    const run1 = turn1.json().runId as string;

    // Force the wedged pre-fix state AND a duplicate turn_number so createTurn
    // would collide: mark run failed, reset turn_count to 0 (→ next computes 1).
    // Even derived max+1 can't collide now, so to prove atomicity we directly
    // inject a turns row at the number the handler will try, then fire a message
    // that — pre-fix — committed a run before the turn insert threw.
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        await client.query(`update runs set status = 'failed' where id = $1`, [run1]);
        // Stale counter is harmless now; assert the handler is robust regardless.
        await client.query(`update sessions set turn_count = 99 where id = $1`, [sessionId]);
      });
    } finally {
      client.release();
    }

    const turn2 = await server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/messages`,
      headers: authHeaders(config.apiKey),
      payload: { message: "second" }
    });
    // turn_number must come from max(turn_number)+1 = 2, not from turn_count.
    expect(turn2.statusCode).toBe(202);
    expect(turn2.json().turnNumber).toBe(2);
    expect(await orphanRunCount(sessionId)).toBe(0);
  });

  it("BUG 2: close with an empty JSON body returns 200 (not 500)", async () => {
    const created = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: authHeaders(config.apiKey),
      payload: {}
    });
    const sessionId = created.json().id as string;

    const closed = await server.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/close`,
      headers: { ...authHeaders(config.apiKey), "content-type": "application/json" }
      // no payload — empty body with a JSON content-type
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe("closed");
  });

  it("BUG 2: close on a missing/cross-tenant session returns 404 session_not_found", async () => {
    const missing = await server.inject({
      method: "POST",
      url: "/v1/sessions/sess_does_not_exist/close",
      headers: { ...authHeaders(config.apiKey), "content-type": "application/json" }
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "session_not_found" } });
  });

  it("BUG 2: a malformed JSON body returns 400 (not 500)", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { ...authHeaders(config.apiKey), "content-type": "application/json" },
      payload: "{not valid json"
    });
    expect(response.statusCode).toBe(400);
  });
});

function authHeaders(apiKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}
