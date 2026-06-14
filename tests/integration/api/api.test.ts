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

  it("records approval decisions as immutable action-bound events", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        approvalMode: "manual",
        runtime: { kind: "codex", mode: "default" }
      }
    });
    expect(createResponse.statusCode).toBe(201);
    const runId = createResponse.json().id as string;
    const actionId = `action_${randomUUID()}`;
    const actionDigest = "sha256:approved_action";
    const argsDigest = "sha256:approved_args";
    const requestEventId = `evt_${randomUUID()}`;

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        await new RunRepository(client).appendEvent({
          runId,
          source: "worker",
          eventType: "approval.requested",
          visibility: "public",
          payload: {
            eventId: requestEventId,
            actionId,
            actionDigest,
            argsDigest,
            actor: "system",
            requestId: `approval_${randomUUID()}`
          }
        });
      });
    } finally {
      client.release();
    }

    const approveResponse = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/actions/${actionId}/approve`,
      headers: authHeaders(config.apiKey),
      payload: { actionDigest, reason: "looks safe" }
    });

    expect(approveResponse.statusCode).toBe(200);
    expect(approveResponse.json()).toMatchObject({
      type: "approval.decided",
      source: "api",
      payload: {
        priorEventId: requestEventId,
        actionId,
        actionDigest,
        argsDigest,
        actor: "human",
        decision: "approved",
        reason: "looks safe"
      }
    });
    expect(approveResponse.json().payload.eventId).toMatch(/^evt_/);
    expect(approveResponse.json().payload.decisionId).toMatch(/^decision_/);

    const duplicateApprove = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/actions/${actionId}/approve`,
      headers: authHeaders(config.apiKey),
      payload: { actionDigest, reason: "duplicate click" }
    });
    expect(duplicateApprove.statusCode).toBe(200);
    expect(duplicateApprove.json().sequence).toBe(approveResponse.json().sequence);

    const conflictingDeny = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/actions/${actionId}/deny`,
      headers: authHeaders(config.apiKey),
      payload: { actionDigest, reason: "too late" }
    });
    expect(conflictingDeny.statusCode).toBe(409);
    expect(conflictingDeny.json()).toMatchObject({
      error: { code: "approval_already_decided" }
    });
  });

  it("rejects approval decisions that do not match the requested action digest", async () => {
    const createResponse = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: {
        task: "Inspect the repo",
        approvalMode: "manual",
        runtime: { kind: "claude_code", permissionMode: "default" }
      }
    });
    expect(createResponse.statusCode).toBe(201);
    const runId = createResponse.json().id as string;
    const actionId = `action_${randomUUID()}`;

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        await new RunRepository(client).appendEvent({
          runId,
          source: "worker",
          eventType: "approval.requested",
          visibility: "public",
          payload: {
            eventId: `evt_${randomUUID()}`,
            actionId,
            actionDigest: "sha256:canonical",
            argsDigest: "sha256:args",
            actor: "system",
            requestId: `approval_${randomUUID()}`
          }
        });
      });
    } finally {
      client.release();
    }

    const response = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/actions/${actionId}/approve`,
      headers: authHeaders(config.apiKey),
      payload: { actionDigest: "sha256:tampered" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "action_digest_mismatch" }
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

  it("does not mount the deprecated session API", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: authHeaders(config.apiKey),
      payload: {}
    });
    expect(response.statusCode).toBe(404);
  });

  // ── M1: run-id multi-turn ──

  // Simulates what the worker does at grace-park time: promote a finished
  // one-shot run into a resumable conversation keyed by its run id.
  async function seedConversation(): Promise<{ runId: string; orgId: string }> {
    const orgId = "org_system"; // the legacy apiKey principal's org
    const runId = `run_${randomUUID()}`;
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.createRun({
          id: runId,
          orgId,
          runtimeKind: "codex",
          runtimeMode: "full_access",
          input: { task: "write fib.py" },
          promptSummary: "write fib.py"
        });
        await repo.updateRunStatus(runId, "starting");
        await repo.updateRunStatus(runId, "running");
        await repo.updateRunStatus(runId, "completed");
        await repo.promoteRunToSession({
          sessionId: `sess_${randomUUID()}`,
          runId,
          orgId,
          runtimeKind: "codex",
          runtimeMode: "full_access",
          prompt: "write fib.py",
          sandboxId: `sandbox_${randomUUID()}`,
          codexSessionId: "thread_abc",
          sandboxState: "suspended",
          idleDeadlineAt: new Date(Date.now() + 10 * 60_000)
        });
      });
    } finally {
      client.release();
    }
    return { runId, orgId };
  }

  it("M1: continue by run id resolves to the conversation and enqueues turn 2", async () => {
    const { runId } = await seedConversation();

    const res = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/messages`,
      headers: authHeaders(config.apiKey),
      payload: { message: "now add a test" }
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.turnNumber).toBe(2);
    expect(body.conversationId).toBe(runId);
    expect(typeof body.runId).toBe("string");
    expect(body.runId).not.toBe(runId); // turn 2 is its own run

    // /turns lists both turns of the conversation, handle = first run id.
    const turns = await server.inject({
      method: "GET",
      url: `/v1/runs/${runId}/turns`,
      headers: authHeaders(config.apiKey)
    });
    expect(turns.statusCode).toBe(200);
    expect(turns.json().conversationId).toBe(runId);
    expect(turns.json().items.map((t: { turnNumber: number }) => t.turnNumber)).toEqual([1, 2]);
  });

  it("M1: a second in-flight message returns 409 (per-conversation concurrency)", async () => {
    const { runId } = await seedConversation();

    const first = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/messages`,
      headers: authHeaders(config.apiKey),
      payload: { message: "turn 2" }
    });
    expect(first.statusCode).toBe(202);

    // turn 2's run is queued (in-flight) → a second message must be rejected.
    const second = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/messages`,
      headers: authHeaders(config.apiKey),
      payload: { message: "turn 3 too soon" }
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "run_busy" } });
  });

  it("M1: continuing a non-promoted run returns 409 run_not_continuable", async () => {
    // A plain completed run that was never promoted (e.g. grace lapsed / not eligible).
    const orgId = "org_system";
    const runId = `run_${randomUUID()}`;
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        await repo.createRun({
          id: runId,
          orgId,
          runtimeKind: "codex",
          runtimeMode: "full_access",
          input: { task: "one-shot only" },
          promptSummary: "one-shot only"
        });
      });
    } finally {
      client.release();
    }

    const res = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/messages`,
      headers: authHeaders(config.apiKey),
      payload: { message: "continue please" }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "run_not_continuable" } });
  });

  it("M1: continuing a missing run returns 404", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/v1/runs/run_does_not_exist/messages",
      headers: authHeaders(config.apiKey),
      payload: { message: "hello" }
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "run_not_found" } });
  });

  it("M1: close by run id arms immediate reclaim and closes the conversation", async () => {
    const { runId } = await seedConversation();

    const res = await server.inject({
      method: "POST",
      url: `/v1/runs/${runId}/close`,
      headers: { ...authHeaders(config.apiKey), "content-type": "application/json" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ closed: true, reclaimed: true });

    // The session is closed and its idle deadline armed in the past.
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const session = await repo.findSessionByRunId(runId, "org_system");
        expect(session?.status).toBe("closed");
        expect(session?.idleDeadlineAt?.getTime()).toBeLessThan(Date.now());
      });
    } finally {
      client.release();
    }
  });

  it("M1: runToApi exposes additive sessionId/conversationId", async () => {
    const { runId } = await seedConversation();
    const res = await server.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
      headers: authHeaders(config.apiKey)
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversationId).toBe(runId); // handle = first run id
    expect(body.sessionId).toMatch(/^sess_/);
  });

  it("M1: the reaper claims only expired suspended sessions and finalizes them", async () => {
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const repo = new RunRepository(client);
        const orgId = "org_system";

        // Expired suspended session (past deadline) → reapable.
        const expiredRun = `run_${randomUUID()}`;
        await repo.createRun({
          id: expiredRun,
          orgId,
          runtimeKind: "codex",
          runtimeMode: "full_access",
          input: { task: "x" },
          promptSummary: "x"
        });
        await repo.updateRunStatus(expiredRun, "starting");
        await repo.updateRunStatus(expiredRun, "running");
        await repo.updateRunStatus(expiredRun, "completed");
        const expiredSession = `sess_${randomUUID()}`;
        await repo.promoteRunToSession({
          sessionId: expiredSession,
          runId: expiredRun,
          orgId,
          runtimeKind: "codex",
          runtimeMode: "full_access",
          prompt: "x",
          sandboxId: `sandbox_${randomUUID()}`,
          sandboxState: "suspended",
          idleDeadlineAt: new Date(Date.now() - 60_000) // already expired
        });

        // Fresh suspended session (future deadline) → NOT reapable.
        const freshRun = `run_${randomUUID()}`;
        await repo.createRun({
          id: freshRun,
          orgId,
          runtimeKind: "codex",
          runtimeMode: "full_access",
          input: { task: "y" },
          promptSummary: "y"
        });
        await repo.updateRunStatus(freshRun, "starting");
        await repo.updateRunStatus(freshRun, "running");
        await repo.updateRunStatus(freshRun, "completed");
        const freshSession = `sess_${randomUUID()}`;
        await repo.promoteRunToSession({
          sessionId: freshSession,
          runId: freshRun,
          orgId,
          runtimeKind: "codex",
          runtimeMode: "full_access",
          prompt: "y",
          sandboxId: `sandbox_${randomUUID()}`,
          sandboxState: "suspended",
          idleDeadlineAt: new Date(Date.now() + 10 * 60_000)
        });

        const claimed = await repo.claimReapableSessions(10);
        const claimedIds = claimed.map((s) => s.id);
        expect(claimedIds).toContain(expiredSession);
        expect(claimedIds).not.toContain(freshSession);

        // Finalize the reaped one.
        await repo.markSessionSandboxDeleted(expiredSession);
        const after = await repo.getSession(expiredSession, orgId);
        expect(after?.sandboxState).toBe("deleted");
        expect(after?.status).toBe("closed");

        // A second sweep must NOT re-claim the finalized session.
        const second = await repo.claimReapableSessions(10);
        expect(second.map((s) => s.id)).not.toContain(expiredSession);
      });
    } finally {
      client.release();
    }
  });
});

// ── Multi-tenant org assertion (managed-cloud path), CONFIG-GATED. ──
describe("AgentRouter API — web-service-token org assertion", () => {
  const config = parseAgentRouterEnv(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const webServiceToken = "arw_test_web_service_token";

  // Two independent UUID tenants to prove isolation.
  const orgA = randomUUID();
  const orgB = randomUUID();

  // One server WITH the web token (multi-tenant), one WITHOUT (single-tenant
  // default) — same DB schema so cross-server visibility can be checked.
  const schema = `${config.testResourcePrefix}_${randomUUID().replaceAll("-", "_")}`;
  const multiTenant = buildApiServer({ pool, schema, apiKey: config.apiKey, webServiceToken });
  const singleTenant = buildApiServer({ pool, schema, apiKey: config.apiKey });

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
      await multiTenant.close();
      await singleTenant.close();
      await pool.end();
    }
  });

  function orgHeaders(orgId: string): Record<string, string> {
    return {
      authorization: `Bearer ${webServiceToken}`,
      "x-ar-org-id": orgId
    };
  }

  async function createRunAs(server: typeof multiTenant, headers: Record<string, string>) {
    const response = await server.inject({
      method: "POST",
      url: "/v1/runs",
      headers,
      payload: { task: "isolation probe", runtime: { kind: "codex", mode: "default" } }
    });
    return response;
  }

  it("(a) web token + valid X-AR-Org-Id resolves to that org and persists it", async () => {
    const response = await createRunAs(multiTenant, orgHeaders(orgA));
    expect(response.statusCode).toBe(201);
    const runId = response.json().id;

    // The persisted run's org_id is the asserted UUID — not the system sentinel.
    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const row = await client.query<{ org_id: string }>(
          "select org_id from runs where id = $1",
          [runId]
        );
        expect(row.rows[0]?.org_id).toBe(orgA);
      });
    } finally {
      client.release();
    }
  });

  it("(a) web token WITHOUT a valid-UUID X-AR-Org-Id is rejected (401)", async () => {
    const missing = await multiTenant.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${webServiceToken}` }
    });
    expect(missing.statusCode).toBe(401);

    const garbage = await multiTenant.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${webServiceToken}`, "x-ar-org-id": "not-a-uuid" }
    });
    expect(garbage.statusCode).toBe(401);
  });

  it("(b) org A cannot read org B's run (cross-tenant 404 + list isolation)", async () => {
    const created = await createRunAs(multiTenant, orgHeaders(orgA));
    expect(created.statusCode).toBe(201);
    const runIdA = created.json().id;

    // Direct fetch of A's run while asserting org B → 404.
    const crossGet = await multiTenant.inject({
      method: "GET",
      url: `/v1/runs/${runIdA}`,
      headers: orgHeaders(orgB)
    });
    expect(crossGet.statusCode).toBe(404);

    // B's run list never contains A's run.
    const listB = await multiTenant.inject({
      method: "GET",
      url: "/v1/runs",
      headers: orgHeaders(orgB)
    });
    expect(listB.statusCode).toBe(200);
    expect(listB.json().items.map((r: { id: string }) => r.id)).not.toContain(runIdA);

    // A can still read its own run.
    const selfGet = await multiTenant.inject({
      method: "GET",
      url: `/v1/runs/${runIdA}`,
      headers: orgHeaders(orgA)
    });
    expect(selfGet.statusCode).toBe(200);
  });

  it("(c) single-tenant default is unchanged: the web token is NOT accepted, only the api key works", async () => {
    // No web token configured → the cloud token is just an unknown bearer (401).
    const asWebToken = await singleTenant.inject({
      method: "GET",
      url: "/v1/runs",
      headers: orgHeaders(orgA)
    });
    expect(asWebToken.statusCode).toBe(401);

    // The configured api key still works and resolves to the system org.
    const created = await singleTenant.inject({
      method: "POST",
      url: "/v1/runs",
      headers: authHeaders(config.apiKey),
      payload: { task: "single tenant probe", runtime: { kind: "codex", mode: "default" } }
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().id;

    const client = await pool.connect();
    try {
      await withSearchPath(client, schema, async () => {
        const row = await client.query<{ org_id: string }>(
          "select org_id from runs where id = $1",
          [runId]
        );
        expect(row.rows[0]?.org_id).toBe("org_system");
      });
    } finally {
      client.release();
    }
  });
});

function authHeaders(apiKey: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
  };
}
