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
});

function authHeaders(apiKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}
