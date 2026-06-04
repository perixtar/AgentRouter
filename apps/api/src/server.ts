import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyInstance,
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
  withSearchPath
} from "@agentrouter/db";
import type { AgentResponse, RuntimePermissionValue } from "@agentrouter/core";

export interface BuildApiServerInput {
  pool: Pool;
  schema: string;
  apiKey: string;
  /**
   * Optional shared web→API service token (the managed-cloud path). When set
   * AND the request's bearer equals it AND a valid-UUID `X-AR-Org-Id` header is
   * present, that org is trusted as the request's tenant (the Next.js web server
   * asserts the logged-in user's real org). When UNSET the API behaves exactly
   * as a single-tenant self-hosted runtime — only the `apiKey` bearer is
   * accepted and it resolves to the fixed system org.
   */
  webServiceToken?: string;
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

const conversationMessageSchema = z.strictObject({
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

    return { items: runs.map((run) => runToApi(run)) };
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
    const orgId = orgOf(request);
    const data = await withRepository(input, async (repo) => {
      const run = await repo.getRun(runId, orgId);
      if (!run) return undefined;
      // Resolve the conversation handle (first run id) when this run is part of
      // one — additive, doesn't change the create contract.
      const session = run.sessionId
        ? await repo.findSessionByRunId(runId, orgId)
        : undefined;
      return { run, conversationId: session?.originRunId };
    });
    if (!data) throw new ApiError(404, "run_not_found", "Run not found");
    return runToApi(data.run, { conversationId: data.conversationId ?? runId });
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

  // ── Run-id multi-turn (M1): the run id is the conversation handle. ──

  // Continue a conversation by run id. Resolves the run to its session (a
  // grace-eligible run was promoted to one when it finished); enqueues the next
  // turn with hardened atomic turn+run creation.
  server.post("/v1/runs/:runId/messages", async (request, reply) => {
    const { runId } = runParams(request);
    const orgId = orgOf(request);
    const parsed = conversationMessageSchema.parse(request.body);

    const outcome = await withClient(input, async (client) => {
      await client.query("begin");
      try {
        const repo = new RunRepository(client);
        const run = await repo.getRun(runId, orgId);
        if (!run) {
          await client.query("rollback");
          return { error: "run_not_found" as const };
        }
        const session = await repo.findSessionByRunId(runId, orgId);
        if (!session) {
          // The run finished but isn't continuable (never grace-eligible, or its
          // grace window already lapsed and the reaper reclaimed the sandbox).
          await client.query("rollback");
          return { error: "not_continuable" as const };
        }
        const result = await enqueueTurn(repo, session, orgId, parsed.message);
        if ("error" in result) {
          await client.query("rollback");
          return result;
        }
        await client.query("commit");
        return { ...result, sessionId: session.id };
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });

    if ("error" in outcome) {
      if (outcome.error === "run_not_found") throw new ApiError(404, "run_not_found", "Run not found");
      if (outcome.error === "not_continuable") {
        throw new ApiError(
          409,
          "run_not_continuable",
          "This run is not continuable (no active conversation; its sandbox may have been reclaimed)"
        );
      }
      if (outcome.error === "closed") throw new ApiError(409, "session_closed", "Conversation is closed");
      throw new ApiError(409, "run_busy", "A turn is already in progress for this conversation");
    }

    reply.status(202);
    return { runId: outcome.runId, turnNumber: outcome.turnNumber, conversationId: runId };
  });

  // List the turns of a conversation by its handle run id.
  server.get("/v1/runs/:runId/turns", async (request) => {
    const { runId } = runParams(request);
    const orgId = orgOf(request);
    const data = await withRepository(input, async (repo) => {
      const run = await repo.getRun(runId, orgId);
      if (!run) return undefined;
      const session = await repo.findSessionByRunId(runId, orgId);
      if (!session) {
        // A standalone (uncontinued) run is a single implicit turn.
        return {
          conversationId: runId,
          turns: [
            { id: runId, runId, turnNumber: 1, prompt: run.promptSummary, createdAt: run.queuedAt }
          ]
        };
      }
      const turns = await repo.listTurns(session.id, orgId);
      return { conversationId: session.originRunId ?? runId, turns };
    });
    if (!data) throw new ApiError(404, "run_not_found", "Run not found");
    return {
      conversationId: data.conversationId,
      items: data.turns.map((t) => ({
        id: t.id,
        runId: t.runId,
        turnNumber: t.turnNumber,
        prompt: t.prompt,
        createdAt:
          t.createdAt instanceof Date ? t.createdAt.toISOString() : new Date(t.createdAt).toISOString()
      }))
    };
  });

  // Close a conversation by run id → immediate sandbox reclaim (sets the reaper
  // deadline to now so the next sweep deletes it; closes the session).
  server.post("/v1/runs/:runId/close", async (request) => {
    const { runId } = runParams(request);
    const orgId = orgOf(request);
    const result = await withRepository(input, async (repo) => {
      const run = await repo.getRun(runId, orgId);
      if (!run) return { error: "run_not_found" as const };
      const session = await repo.findSessionByRunId(runId, orgId);
      if (!session) return { closed: true, conversationId: runId, reclaimed: false };
      // Arm immediate reclaim, then close. The worker reaper deletes the sandbox
      // on its next sweep; we never block the request on Daytona.
      if (session.sandboxState === "suspended" || session.sandboxState === "running") {
        await repo.setSessionIdleDeadline({ sessionId: session.id, idleDeadlineAt: new Date(0) });
      }
      await repo.closeSession(session.id, orgId);
      return { closed: true, conversationId: session.originRunId ?? runId, reclaimed: true };
    });
    if ("error" in result) throw new ApiError(404, "run_not_found", "Run not found");
    return result;
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

  return server;
}

/**
 * Atomically enqueues the next turn of a conversation: concurrency-guards the
 * session, derives the turn number from the actual turns (max+1), creates the
 * turn row then the run (turn-first so a UNIQUE collision rolls back before any
 * run is enqueued). MUST run inside a transaction owned by the caller.
 */
async function enqueueTurn(
  repo: RunRepository,
  session: SessionRecord,
  orgId: string,
  message: string
): Promise<{ runId: string; turnNumber: number } | { error: "closed" | "busy" }> {
  if (session.status !== "active") return { error: "closed" };

  const claimed = await repo.beginSessionTurn(session.id, orgId);
  if (!claimed) return { error: "busy" };

  const turnNumber = await repo.nextTurnNumber(session.id);
  const runId = `run_${randomUUID()}`;
  await repo.createTurn({
    id: `turn_${randomUUID()}`,
    sessionId: session.id,
    orgId,
    runId,
    turnNumber,
    prompt: message
  });
  await repo.createRun({
    id: runId,
    orgId,
    sessionId: session.id,
    runtimeKind: "codex",
    runtimeMode: session.runtimeMode,
    runtimeModel: session.runtimeModel,
    input: { task: message, runtime: { kind: "codex", mode: session.runtimeMode } },
    promptSummary: message.slice(0, 500)
  });
  await repo.setSessionTurnCount(session.id, turnNumber);
  return { runId, turnNumber };
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

  // (a) Managed-cloud org assertion — CONFIG-GATED. Only active when a web
  // service token is configured. The trusted Next.js web server presents this
  // token and asserts the logged-in user's real org via X-AR-Org-Id (a UUID).
  // When the token is unset this whole branch is skipped, so the public OSS
  // default stays single-tenant (only path (b) below).
  const webServiceToken = input.webServiceToken ?? process.env.AGENTROUTER_WEB_SERVICE_TOKEN;
  if (webServiceToken && timingSafeEqualStr(bearer, webServiceToken)) {
    const orgId = assertedOrgId(request);
    if (!orgId) {
      throw new ApiError(
        401,
        "unauthorized",
        "Web service token requires a valid-UUID X-AR-Org-Id header"
      );
    }
    return { orgId };
  }

  // (b) Self-hosted auth: one configured bearer token for all local clients.
  // Resolves to a fixed system org so its runs are still tenant-scoped.
  if (timingSafeEqualStr(bearer, input.apiKey)) {
    return { orgId: SYSTEM_ORG_ID };
  }

  throw new ApiError(401, "unauthorized", "Missing or invalid bearer token");
}

/** Fixed org for the self-hosted `AGENTROUTER_API_KEY` path. */
const SYSTEM_ORG_ID = "org_system";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The asserted tenant org from the `X-AR-Org-Id` header. Only honored for the
 * web-service-token path; must be a valid UUID (a real cloud tenant), so an
 * absent/garbage header can never be trusted as an org.
 */
function assertedOrgId(request: FastifyRequest): string | undefined {
  const header = request.headers["x-ar-org-id"];
  const value = Array.isArray(header) ? header[0] : header;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return UUID_RE.test(trimmed) ? trimmed : undefined;
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

function runToApi(
  run: RunRecord,
  extras: { conversationId?: string } = {}
): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    runtime: runtimeToApi(run.runtimeKind, run.runtimeMode, run.runtimeModel),
    task: run.promptSummary,
    input: run.input,
    lastEventSeq: Number(run.lastEventSeq),
    // Multi-turn (additive): the conversation this run belongs to. `sessionId`
    // is the internal session id (null for an uncontinued one-shot); the public
    // conversation handle is the first run's id.
    sessionId: run.sessionId ?? null,
    conversationId: extras.conversationId ?? run.id,
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
    providerEventType: event.providerEventType,
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
