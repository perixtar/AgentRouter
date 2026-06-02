import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import type { Pool, PoolClient } from "pg";
import { z, ZodError } from "zod";
import {
  RunRepository,
  type ArtifactRecord,
  type EventRecord,
  type RunRecord,
  type SessionRecord,
  type TurnRecord,
  withSearchPath
} from "@agentrouter/db";
import { encrypt, lastFour } from "@agentrouter/secret-box";
import type { AgentResponse, RuntimePermissionValue } from "@agentrouter/core";

export interface BuildApiServerInput {
  pool: Pool;
  schema: string;
  apiKey: string;
  /**
   * Shared web→API service token. When the request's bearer equals this, the
   * asserted `X-AR-Org-Id` header is trusted as the org (the Next.js web server
   * path). External SDK customers instead present an `ar_live_…` key.
   */
  webServiceToken?: string;
  /**
   * Base64 master key for BYOK envelope encryption. Required for the
   * /v1/provider-keys endpoints (the only place plaintext is handled). Falls
   * back to AGENTROUTER_MASTER_KEY in the env when omitted.
   */
  masterKey?: string;
  artifactBytes?: {
    getObjectBytes(key: string): Promise<Buffer>;
  };
}

/** Resolved auth principal: which org this authenticated request acts as. */
interface AuthContext {
  orgId: string;
}

// Per-request org, set by the auth preHandler and read by handlers.
declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const runtimeModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:/-]+$/, "Model can contain letters, numbers, '.', '_', ':', '/', and '-'");

const codexRuntimeSchema = z.strictObject({
  kind: z.literal("codex"),
  mode: z.enum(["default", "read_only", "full_access", "auto_review"]).default("default"),
  model: runtimeModelSchema.optional()
});

const claudeCodeRuntimeSchema = z.strictObject({
  kind: z.literal("claude_code"),
  permissionMode: z
    .enum(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"])
    .default("default"),
  model: runtimeModelSchema.optional()
});

const runtimeSchema = z
  .discriminatedUnion("kind", [codexRuntimeSchema, claudeCodeRuntimeSchema])
  .default({ kind: "codex", mode: "default" });

const createRunSchema = z.strictObject({
  task: z.string().trim().min(1).max(120_000),
  runtime: runtimeSchema.default({ kind: "codex", mode: "default" }),
  metadata: z.record(z.string(), z.unknown()).optional()
});

// BYOK: OpenAI keys are `sk-…` (incl. `sk-proj-…`). Trim + format-validate so
// an obvious paste error fails fast before it is encrypted.
const providerKeySchema = z.strictObject({
  provider: z.enum(["openai", "anthropic"]).default("openai"),
  key: z
    .string()
    .trim()
    .min(20)
    .max(400)
    .regex(/^sk-[A-Za-z0-9_-]+$/, "Expected an OpenAI key starting with 'sk-'")
});

// Multi-turn sessions are Codex-only for M4.
const createSessionSchema = z.strictObject({
  runtime: codexRuntimeSchema.default({ kind: "codex", mode: "full_access" }),
  title: z.string().trim().max(200).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const sessionMessageSchema = z.strictObject({
  message: z.string().trim().min(1).max(120_000)
});

const unsupportedConfigKeys = new Set([
  "model",
  "tools",
  "mcpServers",
  "rawArgs",
  "cliArgs",
  "providerArgs",
  "codexArgs",
  "claudeArgs"
]);

const unsupportedWorkspaceKeys = new Set(["source", "repoUrl", "workspace", "checkout"]);

export function buildApiServer(input: BuildApiServerInput): FastifyInstance {
  const server = Fastify({ logger: false });

  // Tolerate an empty body sent with `content-type: application/json` (e.g.
  // POST /close, /cancel). Fastify's default JSON parser throws on empty input
  // which would surface as a 500; treat empty/whitespace as `{}`. (Bug 2 fix.)
  server.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (text.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        const err = error as Error & { statusCode?: number };
        err.statusCode = 400;
        done(err, undefined);
      }
    }
  );

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details ?? {}
        }
      });
      return;
    }

    if (error instanceof ZodError) {
      reply.status(400).send({
        error: {
          code: "validation_error",
          message: "Invalid request",
          details: { issues: error.issues }
        }
      });
      return;
    }

    // Honor a client-error statusCode set by Fastify (e.g. malformed JSON body)
    // so a bad request doesn't masquerade as a 500.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
      reply.status(statusCode).send({
        error: { code: "bad_request", message: "Invalid request" }
      });
      return;
    }

    reply.status(500).send({
      error: {
        code: "internal_error",
        message: "Unexpected server error"
      }
    });
  });

  server.get("/healthz", async () => ({ ok: true }));

  server.addHook("preHandler", async (request) => {
    if (request.routeOptions.url === "/healthz") return;
    request.auth = await authenticate(request, input);
  });

  server.get("/v1/runs", async (request) => {
    const query = z
      .object({
        status: z
          .enum([
            "active",
            "queued",
            "starting",
            "running",
            "cancelling",
            "cancelled",
            "completed",
            "failed"
          ])
          .optional(),
        limit: z.coerce.number().int().positive().max(100).optional()
      })
      .parse(request.query);

    const orgId = orgOf(request);
    const runs = await withRepository(input, async (repo) =>
      repo.listRuns({ orgId, status: query.status, limit: query.limit })
    );

    return { items: runs.map(runToApi) };
  });

  server.post("/v1/runs", async (request, reply) => {
    assertNoUnsupportedConfiguration(request.body);
    const parsed = createRunSchema.parse(request.body);
    const orgId = orgOf(request);

    const requestHash = hashStableJson(parsed);
    const idempotencyKey = request.headers["idempotency-key"];
    const keyHash = typeof idempotencyKey === "string" ? hashString(idempotencyKey) : undefined;
    const runId = `run_${randomUUID()}`;

    const result = await withClient(input, async (client) => {
      await client.query("begin");
      try {
        const repo = new RunRepository(client);

        if (keyHash) {
          const existing = await client.query(
            `
              select request_hash, run_id
              from idempotency_keys
              where key_hash = $1 and expires_at > now()
              for update
            `,
            [keyHash]
          );

          if (existing.rows[0]) {
            if (existing.rows[0].request_hash !== requestHash) {
              throw new ApiError(
                409,
                "idempotency_conflict",
                "Idempotency-Key was reused with a different request body"
              );
            }

            if (!existing.rows[0].run_id) {
              throw new ApiError(409, "idempotency_in_progress", "Idempotent request is still creating");
            }

            const existingRun = await repo.getRun(existing.rows[0].run_id, orgId);
            if (!existingRun) {
              throw new ApiError(500, "internal_error", "Idempotency record points at a missing run");
            }
            await client.query("commit");
            return { run: existingRun, replay: true };
          }

          await client.query(
            `
              insert into idempotency_keys (key_hash, request_hash, expires_at)
              values ($1, $2, now() + interval '24 hours')
            `,
            [keyHash, requestHash]
          );
        }

        const run = await repo.createRun({
          id: runId,
          orgId,
          runtimeKind: parsed.runtime.kind,
          runtimeMode: runtimePermissionValueFromRequest(parsed.runtime),
          runtimeModel: parsed.runtime.model,
          input: parsed,
          promptSummary: parsed.task.slice(0, 500)
        });

        if (keyHash) {
          await client.query("update idempotency_keys set run_id = $2 where key_hash = $1", [
            keyHash,
            run.id
          ]);
        }

        await client.query("commit");
        return { run, replay: false };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });

    reply.status(result.replay ? 200 : 201);
    return runToApi(result.run);
  });

  server.get("/v1/runs/:runId", async (request) => {
    const { runId } = runParams(request);
    const run = await getRunOrThrow(input, runId, orgOf(request));
    return runToApi(run);
  });

  server.get("/v1/runs/:runId/events", async (request) => {
    const { runId } = runParams(request);
    const query = z
      .object({
        afterSeq: z.coerce.bigint().default(0n),
        limit: z.coerce.number().int().positive().max(500).default(100)
      })
      .parse(request.query);

    const orgId = orgOf(request);
    const events = await withRepository(input, async (repo) => {
      // Consistent 404 for a run not visible to this org (instead of empty-200).
      const run = await repo.getRun(runId, orgId);
      if (!run) throw new ApiError(404, "run_not_found", "Run not found");
      return repo.listEvents({ runId, orgId, afterSeq: query.afterSeq, limit: query.limit });
    });

    const lastEvent = events.at(-1);
    return {
      items: events.map(eventToApi),
      nextAfterSeq: lastEvent ? Number(lastEvent.sequence) : Number(query.afterSeq)
    };
  });

  server.get("/v1/runs/:runId/session", async (request) => {
    const { runId } = runParams(request);
    const orgId = orgOf(request);
    const snapshot = await withRepository(input, async (repo) => {
      const run = await repo.getRun(runId, orgId);
      if (!run) throw new ApiError(404, "run_not_found", "Run not found");
      const artifacts = await repo.listArtifacts(runId, orgId);
      const afterSeq = run.lastEventSeq > 500n ? run.lastEventSeq - 500n : 0n;
      const events = await repo.listEvents({ runId, orgId, afterSeq, limit: 500 });
      return { run, artifacts, events };
    });

    return {
      run: runToApi(snapshot.run),
      eventCursor: { lastEventSeq: Number(snapshot.run.lastEventSeq) },
      response: responseFromEvents(snapshot.events),
      artifactManifest: manifestFromArtifacts(snapshot.artifacts),
      artifacts: { items: snapshot.artifacts.map(artifactToApi) }
    };
  });

  server.get("/v1/runs/:runId/stream", async (request, reply) => {
    const { runId } = runParams(request);
    const lastEventId = request.headers["last-event-id"];
    const query = z
      .object({
        afterSeq: z.coerce.bigint().optional()
      })
      .parse(request.query);
    const afterSeq =
      query.afterSeq ?? (typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? BigInt(lastEventId) : 0n);

    const orgId = orgOf(request);
    const events = await withRepository(input, async (repo) =>
      repo.listEvents({ runId, orgId, afterSeq, limit: 500 })
    );

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });

    if (events.length === 0) {
      reply.raw.write("event: heartbeat\ndata: {}\n\n");
    } else {
      for (const event of events) {
        reply.raw.write(sseEvent(event));
      }
    }

    reply.raw.end();
  });

  server.post("/v1/runs/:runId/cancel", async (request) => {
    const { runId } = runParams(request);
    const orgId = orgOf(request);
    const run = await withRepository(input, async (repo) => repo.cancelRun(runId, orgId));
    if (!run) throw new ApiError(404, "run_not_found", "Run not found");
    return runToApi(run);
  });

  server.get("/v1/runs/:runId/artifacts", async (request) => {
    const { runId } = runParams(request);
    const orgId = orgOf(request);
    const artifacts = await withRepository(input, async (repo) => {
      // Consistent 404 for a run not visible to this org.
      const run = await repo.getRun(runId, orgId);
      if (!run) throw new ApiError(404, "run_not_found", "Run not found");
      return repo.listArtifacts(runId, orgId);
    });
    return { items: artifacts.map(artifactToApi) };
  });

  server.get("/v1/runs/:runId/artifacts/:artifactId/download", async (request, reply) => {
    const params = z.object({ runId: z.string(), artifactId: z.string() }).parse(request.params);

    const artifact = await withRepository(input, async (repo) =>
      repo.getArtifact(params.runId, params.artifactId, orgOf(request))
    );
    if (!artifact) throw new ApiError(404, "artifact_not_found", "Artifact not found");
    if (!input.artifactBytes) {
      throw new ApiError(501, "artifact_download_unconfigured", "Artifact byte store is not configured");
    }

    const bytes = await input.artifactBytes.getObjectBytes(artifact.r2Key);
    reply.header("content-type", artifact.contentType ?? "application/octet-stream");
    reply.header("content-length", String(bytes.byteLength));
    return reply.send(bytes);
  });

  // ── BYOK provider keys (M3) — the only place plaintext is handled. ──

  server.post("/v1/provider-keys", async (request, reply) => {
    const orgId = orgOf(request);
    const body = providerKeySchema.parse(request.body);

    const masterKey = input.masterKey ?? process.env.AGENTROUTER_MASTER_KEY;
    if (!masterKey) {
      throw new ApiError(
        503,
        "byok_unconfigured",
        "Provider key encryption is not configured (missing master key)"
      );
    }

    const enc = encrypt(body.key, masterKey);
    await withRepository(input, async (repo) =>
      repo.upsertProviderKey({
        orgId,
        provider: body.provider,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        tag: enc.tag,
        last4: lastFour(body.key),
        keyVersion: enc.keyVersion
      })
    );

    reply.status(201);
    return { provider: body.provider, last4: lastFour(body.key), connected: true };
  });

  server.get("/v1/provider-keys", async (request) => {
    const orgId = orgOf(request);
    const statuses = await withRepository(input, async (repo) =>
      repo.getProviderKeyStatus(orgId)
    );
    return {
      items: statuses.map((s) => ({
        provider: s.provider,
        last4: s.last4,
        connected: true,
        updatedAt: s.updatedAt.toISOString()
      }))
    };
  });

  server.delete("/v1/provider-keys/:provider", async (request) => {
    const orgId = orgOf(request);
    const { provider } = z
      .object({ provider: z.enum(["openai", "anthropic"]) })
      .parse(request.params);
    const deleted = await withRepository(input, async (repo) =>
      repo.deleteProviderKey(orgId, provider)
    );
    if (!deleted) throw new ApiError(404, "provider_key_not_found", "No provider key to delete");
    return { provider, connected: false };
  });

  // ── Multi-turn sessions (M4) — Codex-only, org-scoped. ──

  server.post("/v1/sessions", async (request, reply) => {
    const orgId = orgOf(request);
    const parsed = createSessionSchema.parse(request.body ?? {});
    const sessionId = `sess_${randomUUID()}`;
    const session = await withRepository(input, async (repo) =>
      repo.createSession({
        id: sessionId,
        orgId,
        runtimeKind: "codex",
        runtimeMode: parsed.runtime.mode,
        runtimeModel: parsed.runtime.model,
        title: parsed.title
      })
    );
    reply.status(201);
    return sessionToApi(session);
  });

  server.get("/v1/sessions", async (request) => {
    const orgId = orgOf(request);
    const sessions = await withRepository(input, async (repo) => repo.listSessions(orgId));
    return { items: sessions.map(sessionToApi) };
  });

  server.get("/v1/sessions/:sessionId", async (request) => {
    const orgId = orgOf(request);
    const { sessionId } = sessionParams(request);
    const result = await withRepository(input, async (repo) => {
      const session = await repo.getSession(sessionId, orgId);
      if (!session) return undefined;
      const turns = await repo.listTurns(sessionId, orgId);
      return { session, turns };
    });
    if (!result) throw new ApiError(404, "session_not_found", "Session not found");
    return {
      ...sessionToApi(result.session),
      turns: result.turns.map(turnToApi)
    };
  });

  server.post("/v1/sessions/:sessionId/messages", async (request, reply) => {
    const orgId = orgOf(request);
    const { sessionId } = sessionParams(request);
    const parsed = sessionMessageSchema.parse(request.body);

    // Atomic: the turn row + run row are created in ONE transaction so a
    // turn-number collision (or any error) rolls back BOTH — never an orphan
    // run that the worker would pick up untracked. (Bug 1 fix.)
    const result = await withClient(input, async (client) => {
      await client.query("begin");
      try {
        const repo = new RunRepository(client);
        const session = await repo.getSession(sessionId, orgId);
        if (!session) {
          await client.query("rollback");
          return { error: "not_found" as const };
        }
        if (session.status !== "active") {
          await client.query("rollback");
          return { error: "closed" as const };
        }

        // Concurrency guard: atomically reject a 2nd in-flight turn.
        const claimed = await repo.beginSessionTurn(sessionId, orgId);
        if (!claimed) {
          await client.query("rollback");
          return { error: "busy" as const };
        }

        // Turn number derived from actual turns (max+1), independent of the
        // success/failure of prior turns — a failed turn never wedges this.
        const turnNumber = await repo.nextTurnNumber(sessionId);
        const runId = `run_${randomUUID()}`;
        // Turn first: if its UNIQUE(session_id, turn_number) collides, we roll
        // back before any run is enqueued.
        await repo.createTurn({
          id: `turn_${randomUUID()}`,
          sessionId,
          orgId,
          runId,
          turnNumber,
          prompt: parsed.message
        });
        await repo.createRun({
          id: runId,
          orgId,
          sessionId,
          runtimeKind: "codex",
          runtimeMode: session.runtimeMode,
          runtimeModel: session.runtimeModel,
          input: { task: parsed.message, runtime: { kind: "codex", mode: session.runtimeMode } },
          promptSummary: parsed.message.slice(0, 500)
        });

        // Keep the display counter equal to the number of turns started, so it
        // never drifts on failed turns (correctness no longer depends on it).
        await repo.setSessionTurnCount(sessionId, turnNumber);

        await client.query("commit");
        return { runId, turnNumber };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });

    if ("error" in result) {
      if (result.error === "not_found") throw new ApiError(404, "session_not_found", "Session not found");
      if (result.error === "closed") throw new ApiError(409, "session_closed", "Session is closed");
      throw new ApiError(409, "session_busy", "A turn is already in progress for this session");
    }

    reply.status(202);
    return { runId: result.runId, turnNumber: result.turnNumber, sessionId };
  });

  server.get("/v1/sessions/:sessionId/events", async (request) => {
    const orgId = orgOf(request);
    const { sessionId } = sessionParams(request);
    const query = z
      .object({
        runId: z.string().optional(),
        afterSeq: z.coerce.bigint().default(0n),
        limit: z.coerce.number().int().positive().max(500).default(200)
      })
      .parse(request.query);

    const data = await withRepository(input, async (repo) => {
      const session = await repo.getSession(sessionId, orgId);
      if (!session) return undefined;
      const turns = await repo.listTurns(sessionId, orgId);
      const runId = query.runId ?? turns.at(-1)?.runId;
      if (!runId) return { session, runId: undefined, events: [], run: undefined };
      const run = await repo.getRun(runId, orgId);
      const events = await repo.listEvents({ runId, orgId, afterSeq: query.afterSeq, limit: query.limit });
      return { session, runId, run, events };
    });
    if (!data) throw new ApiError(404, "session_not_found", "Session not found");

    const lastEvent = data.events.at(-1);
    return {
      sessionId,
      runId: data.runId,
      status: data.run?.status,
      failure:
        data.run?.failureCode || data.run?.failureReason
          ? { code: data.run?.failureCode, reason: data.run?.failureReason }
          : undefined,
      items: data.events.map(eventToApi),
      nextAfterSeq: lastEvent ? Number(lastEvent.sequence) : Number(query.afterSeq)
    };
  });

  server.get("/v1/sessions/:sessionId/stream", async (request, reply) => {
    const orgId = orgOf(request);
    const { sessionId } = sessionParams(request);
    const data = await withRepository(input, async (repo) => {
      const session = await repo.getSession(sessionId, orgId);
      if (!session) return undefined;
      const turns = await repo.listTurns(sessionId, orgId);
      const runId = turns.at(-1)?.runId;
      const events = runId
        ? await repo.listEvents({ runId, orgId, afterSeq: 0n, limit: 500 })
        : [];
      return { events };
    });
    if (!data) throw new ApiError(404, "session_not_found", "Session not found");

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    if (data.events.length === 0) {
      reply.raw.write("event: heartbeat\ndata: {}\n\n");
    } else {
      for (const event of data.events) reply.raw.write(sseEvent(event));
    }
    reply.raw.end();
  });

  server.post("/v1/sessions/:sessionId/close", async (request) => {
    const orgId = orgOf(request);
    const { sessionId } = sessionParams(request);
    const session = await withRepository(input, async (repo) => repo.closeSession(sessionId, orgId));
    if (!session) throw new ApiError(404, "session_not_found", "Session not found");
    return sessionToApi(session);
  });

  return server;
}

function sessionParams(request: FastifyRequest): { sessionId: string } {
  return z.object({ sessionId: z.string().min(1) }).parse(request.params);
}

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

async function withClient<T>(
  input: BuildApiServerInput,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await input.pool.connect();
  try {
    return await withSearchPath(client, input.schema, () => fn(client));
  } finally {
    client.release();
  }
}

async function withRepository<T>(
  input: BuildApiServerInput,
  fn: (repo: RunRepository) => Promise<T>
): Promise<T> {
  return withClient(input, (client) => fn(new RunRepository(client)));
}

async function authenticate(
  request: FastifyRequest,
  input: BuildApiServerInput
): Promise<AuthContext> {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new ApiError(401, "unauthorized", "Missing or invalid bearer token");
  }
  const bearer = authorization.slice("Bearer ".length).trim();

  // (a) Legacy/admin single key — keeps existing tests + tooling working.
  // Resolves to a fixed system org so its runs are still tenant-scoped.
  if (timingSafeEqualStr(bearer, input.apiKey)) {
    const orgId = assertedOrgId(request) ?? SYSTEM_ORG_ID;
    return { orgId };
  }

  // (b) Web service token — trust the asserted X-AR-Org-Id (the web path).
  // Falls back to the env var so the token can be supplied without changing
  // the server bootstrap.
  const webServiceToken = input.webServiceToken ?? process.env.AGENTROUTER_WEB_SERVICE_TOKEN;
  if (webServiceToken && timingSafeEqualStr(bearer, webServiceToken)) {
    const orgId = assertedOrgId(request);
    if (!orgId) {
      throw new ApiError(401, "unauthorized", "Web service token requires an X-AR-Org-Id header");
    }
    return { orgId };
  }

  // (c) External SDK key (ar_live_…) — hash → api_keys row → org_id.
  const keyHash = hashString(bearer);
  const orgId = await withClient(input, async (client) => {
    const result = await client.query<{ org_id: string }>(
      `select org_id from api_keys where key_hash = $1 and revoked_at is null limit 1`,
      [keyHash]
    );
    return result.rows[0]?.org_id;
  });

  if (!orgId) {
    throw new ApiError(401, "unauthorized", "Missing or invalid bearer token");
  }

  // Best-effort last-used touch (non-blocking correctness; ignore errors).
  await withClient(input, async (client) => {
    await client.query(
      `update api_keys set last_used_at = now() where key_hash = $1`,
      [keyHash]
    );
  }).catch(() => undefined);

  return { orgId };
}

/** Fixed org for the legacy admin `AGENTROUTER_API_KEY` path. */
const SYSTEM_ORG_ID = "org_system";

function assertedOrgId(request: FastifyRequest): string | undefined {
  const header = request.headers["x-ar-org-id"];
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function assertNoUnsupportedConfiguration(body: unknown): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  for (const key of Object.keys(body)) {
    if (unsupportedWorkspaceKeys.has(key)) {
      throw new ApiError(
        400,
        "unsupported_workspace_attachment",
        "Workspace attachments are not supported in Phase 1"
      );
    }

    if (unsupportedConfigKeys.has(key)) {
      throw new ApiError(
        400,
        "unsupported_tool_configuration",
        "Custom tools and raw provider CLI arguments are not supported in Phase 1"
      );
    }
  }
}

function runParams(request: FastifyRequest): { runId: string } {
  return z.object({ runId: z.string().min(1) }).parse(request.params);
}

async function getRunOrThrow(
  input: BuildApiServerInput,
  runId: string,
  orgId: string
): Promise<RunRecord> {
  const run = await withRepository(input, async (repo) => repo.getRun(runId, orgId));
  if (!run) throw new ApiError(404, "run_not_found", "Run not found");
  return run;
}

/** The authenticated org for this request (set by the auth preHandler). */
function orgOf(request: FastifyRequest): string {
  const orgId = request.auth?.orgId;
  if (!orgId) {
    throw new ApiError(401, "unauthorized", "Missing authentication context");
  }
  return orgId;
}

function sessionToApi(session: SessionRecord): Record<string, unknown> {
  return {
    id: session.id,
    runtime: runtimeToApi(session.runtimeKind, session.runtimeMode, session.runtimeModel),
    title: session.title,
    status: session.status,
    sandboxState: session.sandboxState,
    turnCount: session.turnCount,
    createdAt: session.createdAt.toISOString(),
    lastActiveAt: session.lastActiveAt.toISOString()
  };
}

function turnToApi(turn: TurnRecord): Record<string, unknown> {
  return {
    id: turn.id,
    runId: turn.runId,
    turnNumber: turn.turnNumber,
    prompt: turn.prompt,
    createdAt: turn.createdAt.toISOString()
  };
}

function runToApi(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    runtime: runtimeToApi(run.runtimeKind, run.runtimeMode, run.runtimeModel),
    task: run.promptSummary,
    input: run.input,
    lastEventSeq: Number(run.lastEventSeq),
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    completedAt: run.completedAt?.toISOString(),
    cancelRequestedAt: run.cancelRequestedAt?.toISOString(),
    failure:
      run.failureCode || run.failureReason
        ? { code: run.failureCode, reason: run.failureReason }
        : undefined
  };
}

function runtimePermissionValueFromRequest(runtime: z.infer<typeof runtimeSchema>): RuntimePermissionValue {
  return runtime.kind === "codex" ? runtime.mode : runtime.permissionMode;
}

function runtimeToApi(
  runtimeKind: string,
  runtimeMode: string,
  runtimeModel?: string
): Record<string, string> {
  if (runtimeKind === "claude_code") {
    return compactStringRecord({
      kind: runtimeKind,
      permissionMode: runtimeMode,
      model: runtimeModel
    });
  }

  return compactStringRecord({
    kind: runtimeKind,
    mode: runtimeMode,
    model: runtimeModel
  });
}

function compactStringRecord(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function eventToApi(event: EventRecord): Record<string, unknown> {
  return {
    runId: event.runId,
    sequence: Number(event.sequence),
    type: event.eventType,
    source: event.source,
    visibility: event.visibility,
    payload: event.payload,
    artifactRef: event.artifactRef,
    isTruncated: event.isTruncated,
    createdAt: event.createdAt.toISOString()
  };
}

function artifactToApi(artifact: ArtifactRecord): Record<string, unknown> {
  return {
    id: artifact.id,
    runId: artifact.runId,
    kind: artifact.kind,
    r2Key: artifact.r2Key,
    contentType: artifact.contentType,
    sizeBytes: Number(artifact.sizeBytes),
    sha256: artifact.sha256,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt.toISOString()
  };
}

function manifestFromArtifacts(artifacts: ArtifactRecord[]): Record<string, unknown> {
  const manifest = artifacts.find((artifact) => artifact.kind === "session_manifest");
  if (!manifest) {
    return { status: "missing" };
  }

  return {
    status: "available",
    artifactId: manifest.id,
    r2Key: manifest.r2Key,
    sizeBytes: Number(manifest.sizeBytes),
    sha256: manifest.sha256
  };
}

function responseFromEvents(events: EventRecord[]): (AgentResponse & { provider?: string }) | null {
  const event = [...events].reverse().find((item) => item.eventType === "agent.response");
  if (!event) return null;
  const payload = event.payload;
  if (typeof payload.text !== "string") return null;
  const parts = Array.isArray(payload.parts)
    ? payload.parts.filter(isAgentResponseTextPart)
    : [{ type: "text" as const, text: payload.text }];

  return {
    text: payload.text,
    parts,
    providerEventType:
      typeof payload.providerEventType === "string" ? payload.providerEventType : undefined,
    provider: typeof payload.provider === "string" ? payload.provider : undefined
  };
}

function isAgentResponseTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "text" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}

function sseEvent(event: EventRecord): string {
  return [
    `id: ${event.sequence.toString()}`,
    `event: ${event.eventType}`,
    `data: ${JSON.stringify(eventToApi(event))}`,
    "",
    ""
  ].join("\n");
}

function hashStableJson(value: unknown): string {
  return hashString(JSON.stringify(sortJson(value)));
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  );
}
