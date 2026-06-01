import { createHash, randomUUID } from "node:crypto";
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
  withSearchPath
} from "@agentrouter/db";
import type { RuntimePermissionValue } from "@agentrouter/core";

export interface BuildApiServerInput {
  pool: Pool;
  schema: string;
  apiKey: string;
  artifactBytes?: {
    getObjectBytes(key: string): Promise<Buffer>;
  };
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
    authenticate(request, input.apiKey);
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

    const runs = await withRepository(input, async (repo) =>
      repo.listRuns({ status: query.status, limit: query.limit })
    );

    return { items: runs.map(runToApi) };
  });

  server.post("/v1/runs", async (request, reply) => {
    assertNoUnsupportedConfiguration(request.body);
    const parsed = createRunSchema.parse(request.body);

    if (parsed.runtime.kind !== "codex") {
      throw new ApiError(400, "unsupported_runtime_kind", "Phase 1A supports Codex runs only");
    }

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

            const existingRun = await repo.getRun(existing.rows[0].run_id);
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
    const run = await getRunOrThrow(input, runId);
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

    const events = await withRepository(input, async (repo) =>
      repo.listEvents({ runId, afterSeq: query.afterSeq, limit: query.limit })
    );

    const lastEvent = events.at(-1);
    return {
      items: events.map(eventToApi),
      nextAfterSeq: lastEvent ? Number(lastEvent.sequence) : Number(query.afterSeq)
    };
  });

  server.get("/v1/runs/:runId/session", async (request) => {
    const { runId } = runParams(request);
    const snapshot = await withRepository(input, async (repo) => {
      const run = await repo.getRun(runId);
      if (!run) throw new ApiError(404, "run_not_found", "Run not found");
      const artifacts = await repo.listArtifacts(runId);
      return { run, artifacts };
    });

    return {
      run: runToApi(snapshot.run),
      eventCursor: { lastEventSeq: Number(snapshot.run.lastEventSeq) },
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

    const events = await withRepository(input, async (repo) =>
      repo.listEvents({ runId, afterSeq, limit: 500 })
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
    const run = await withRepository(input, async (repo) => repo.cancelRun(runId));
    return runToApi(run);
  });

  server.get("/v1/runs/:runId/artifacts", async (request) => {
    const { runId } = runParams(request);
    const artifacts = await withRepository(input, async (repo) => repo.listArtifacts(runId));
    return { items: artifacts.map(artifactToApi) };
  });

  server.get("/v1/runs/:runId/artifacts/:artifactId/download", async (request, reply) => {
    const params = z.object({ runId: z.string(), artifactId: z.string() }).parse(request.params);

    const artifact = await withRepository(input, async (repo) =>
      repo.getArtifact(params.runId, params.artifactId)
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

function authenticate(request: FastifyRequest, apiKey: string): void {
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${apiKey}`) {
    throw new ApiError(401, "unauthorized", "Missing or invalid bearer token");
  }
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

async function getRunOrThrow(input: BuildApiServerInput, runId: string): Promise<RunRecord> {
  const run = await withRepository(input, async (repo) => repo.getRun(runId));
  if (!run) throw new ApiError(404, "run_not_found", "Run not found");
  return run;
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
