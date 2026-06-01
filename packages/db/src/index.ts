import type { PoolClient } from "pg";
import {
  normalizeEventPayload,
  transitionRunStatus,
  type ArtifactRef,
  type ClaudeCodePermissionMode,
  type CodexRuntimeMode,
  type RuntimeModel,
  type RuntimeKind,
  type RuntimePermissionValue,
  type RunStatus
} from "@agentrouter/core";

export function quoteIdent(value: string): string {
  if (value.includes("\0")) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }

  return `"${value.replaceAll('"', '""')}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes("\0")) {
    throw new Error(`Invalid SQL literal: ${value}`);
  }

  return `'${value.replaceAll("'", "''")}'`;
}

export async function withSearchPath<T>(
  client: PoolClient,
  schema: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = await client.query("show search_path");
  await client.query(`set search_path to ${quoteIdent(schema)}, public`);

  try {
    return await fn();
  } finally {
    await client.query(`set search_path to ${previous.rows[0].search_path}`);
  }
}

export async function dropSchema(client: PoolClient, schema: string): Promise<void> {
  await client.query(`drop schema if exists ${quoteIdent(schema)} cascade`);
}

export async function applyPhase1Migrations(client: PoolClient, schema: string): Promise<void> {
  await client.query(`create schema if not exists ${quoteIdent(schema)}`);

  await withSearchPath(client, schema, async () => {
    await client.query(`
      create table if not exists runs (
        id text primary key,
        runtime_kind text not null check (runtime_kind in ('codex', 'claude_code')),
        runtime_mode text not null,
        runtime_model text,
        constraint runs_runtime_kind_mode_check check (
          (runtime_kind = 'codex' and runtime_mode in ('default', 'read_only', 'full_access', 'auto_review'))
          or
          (runtime_kind = 'claude_code' and runtime_mode in ('default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'))
        ),
        status text not null default 'queued'
          check (status in ('queued', 'starting', 'running', 'cancelling', 'cancelled', 'completed', 'failed')),
        input_json jsonb not null default '{}'::jsonb,
        prompt_summary text not null default '',
        last_event_seq bigint not null default 0,
        queued_at timestamptz not null default now(),
        started_at timestamptz,
        completed_at timestamptz,
        cancel_requested_at timestamptz,
        failure_code text,
        failure_reason text
      )
    `);

    await client.query(`
      create table if not exists idempotency_keys (
        key_hash text primary key,
        request_hash text not null,
        run_id text references runs(id),
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      )
    `);

    await client.query(`
      create table if not exists workers (
        id text primary key,
        region text,
        status text not null default 'active',
        capacity integer not null default 1,
        last_heartbeat_at timestamptz not null default now(),
        version text not null default 'dev'
      )
    `);

    await client.query(`
      create table if not exists run_attempts (
        id text primary key,
        run_id text not null references runs(id),
        attempt_number integer not null,
        worker_id text references workers(id),
        runtime_kind text not null check (runtime_kind in ('codex', 'claude_code')),
        runtime_mode text not null,
        runtime_model text,
        constraint run_attempts_runtime_kind_mode_check check (
          (runtime_kind = 'codex' and runtime_mode in ('default', 'read_only', 'full_access', 'auto_review'))
          or
          (runtime_kind = 'claude_code' and runtime_mode in ('default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'))
        ),
        permission_profile_json jsonb not null default '{}'::jsonb,
        credential_strategy text not null check (credential_strategy in ('provider_proxy', 'direct_env_proven')),
        cli_version text,
        provider_session_json jsonb not null default '{}'::jsonb,
        status text not null default 'claimed'
          check (status in ('claimed', 'starting', 'running', 'completed', 'failed', 'cancelled')),
        claimed_at timestamptz not null default now(),
        started_at timestamptz,
        completed_at timestamptz,
        last_heartbeat_at timestamptz,
        exit_code integer,
        failure_code text,
        failure_reason text,
        unique (run_id, attempt_number)
      )
    `);

    await client.query(`
      create table if not exists sandbox_sessions (
        id text primary key,
        run_id text not null references runs(id),
        run_attempt_id text references run_attempts(id),
        provider text not null,
        external_id text not null,
        status text not null default 'creating',
        expires_at timestamptz,
        last_heartbeat_at timestamptz,
        stopped_at timestamptz,
        deleted_at timestamptz
      )
    `);

    await client.query(`
      create table if not exists run_events (
        run_id text not null references runs(id),
        sequence bigint not null,
        source text not null,
        event_type text not null,
        provider_event_type text,
        provider_event_id text,
        visibility text not null default 'internal'
          check (visibility in ('public', 'internal', 'redacted')),
        payload_json jsonb not null default '{}'::jsonb,
        payload_size_bytes integer not null default 0
          check (payload_size_bytes <= 32768),
        artifact_ref_json jsonb not null default '{}'::jsonb,
        is_truncated boolean not null default false,
        created_at timestamptz not null default now(),
        primary key (run_id, sequence),
        check (octet_length(payload_json::text) <= 32768)
      )
    `);

    await client.query(`
      create table if not exists artifacts (
        id text primary key,
        run_id text not null references runs(id),
        run_attempt_id text references run_attempts(id),
        kind text not null,
        r2_key text not null unique,
        content_type text,
        size_bytes bigint not null,
        sha256 text not null,
        metadata_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        deleted_at timestamptz
      )
    `);

    await client.query(`
      create table if not exists artifact_manifests (
        id text primary key,
        run_id text not null references runs(id),
        manifest_artifact_id text references artifacts(id),
        status text not null check (status in ('partial', 'complete')),
        is_current boolean not null default true,
        event_sequence_start bigint,
        event_sequence_end bigint,
        artifact_count integer not null default 0,
        total_size_bytes bigint not null default 0,
        workspace_file_count integer not null default 0,
        metadata_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);

    await client.query(`
      create table if not exists cleanup_ledger (
        id text primary key,
        run_id text references runs(id),
        run_attempt_id text references run_attempts(id),
        resource_type text not null,
        provider text not null,
        external_id text not null,
        status text not null default 'pending',
        attempts integer not null default 0,
        next_retry_at timestamptz,
        last_error text,
        created_at timestamptz not null default now()
      )
    `);

    await client.query("create index if not exists runs_status_queued_idx on runs(status, queued_at)");
    await client.query("create index if not exists run_events_created_at_idx on run_events(created_at desc)");
    await client.query("create index if not exists artifacts_run_id_idx on artifacts(run_id)");
    await client.query("alter table runs add column if not exists runtime_model text");
    await client.query("alter table run_attempts add column if not exists runtime_model text");
    await client.query("alter table runs drop constraint if exists runs_runtime_mode_check");
    await client.query("alter table runs drop constraint if exists runs_check");
    await client.query(
      "alter table run_attempts drop constraint if exists run_attempts_runtime_mode_check"
    );
    await client.query("alter table run_attempts drop constraint if exists run_attempts_check");
    await addRuntimeModeConstraint(
      client,
      "runs",
      "runs_runtime_kind_mode_check"
    );
    await addRuntimeModeConstraint(
      client,
      "run_attempts",
      "run_attempts_runtime_kind_mode_check"
    );
  });
}

async function addRuntimeModeConstraint(
  client: PoolClient,
  tableName: string,
  constraintName: string
): Promise<void> {
  await client.query(`
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conname = ${quoteLiteral(constraintName)} and conrelid = ${quoteLiteral(tableName)}::regclass
      ) then
        alter table ${quoteIdent(tableName)}
        add constraint ${quoteIdent(constraintName)}
        check (
          (runtime_kind = 'codex' and runtime_mode in ('default', 'read_only', 'full_access', 'auto_review'))
          or
          (runtime_kind = 'claude_code' and runtime_mode in ('default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'))
        );
      end if;
    end
    $$;
  `);
}

export interface CreateRunInput {
  id: string;
  runtimeKind: RuntimeKind;
  runtimeMode: RuntimePermissionValue;
  runtimeModel?: RuntimeModel;
  input: Record<string, unknown>;
  promptSummary: string;
}

export interface RunRecord {
  id: string;
  runtimeKind: RuntimeKind;
  runtimeMode: RuntimePermissionValue;
  runtimeModel?: RuntimeModel;
  status: RunStatus;
  lastEventSeq: bigint;
  input: Record<string, unknown>;
  promptSummary: string;
  queuedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  cancelRequestedAt?: Date;
  failureCode?: string;
  failureReason?: string;
}

export interface CodexRunRecord extends RunRecord {
  runtimeKind: "codex";
  runtimeMode: CodexRuntimeMode;
}

export interface ClaudeCodeRunRecord extends RunRecord {
  runtimeKind: "claude_code";
  runtimeMode: ClaudeCodePermissionMode;
}

export function isCodexRunRecord(run: RunRecord): run is CodexRunRecord {
  return (
    run.runtimeKind === "codex" &&
    ["default", "read_only", "full_access", "auto_review"].includes(run.runtimeMode)
  );
}

export function isClaudeCodeRunRecord(run: RunRecord): run is ClaudeCodeRunRecord {
  return (
    run.runtimeKind === "claude_code" &&
    ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"].includes(
      run.runtimeMode
    )
  );
}

export interface AppendEventInput {
  runId: string;
  source: string;
  eventType: string;
  visibility: "public" | "internal" | "redacted";
  payload: Record<string, unknown>;
  artifactRef?: ArtifactRef;
}

export interface EventRecord {
  runId: string;
  sequence: bigint;
  eventType: string;
  source: string;
  visibility: "public" | "internal" | "redacted";
  payload: Record<string, unknown>;
  artifactRef?: ArtifactRef;
  isTruncated: boolean;
  createdAt: Date;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  runAttemptId?: string;
  kind: string;
  r2Key: string;
  contentType?: string;
  sizeBytes: bigint;
  sha256: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface RecordArtifactInput {
  id: string;
  runId: string;
  runAttemptId?: string;
  kind: string;
  r2Key: string;
  contentType?: string;
  sizeBytes: bigint | number;
  sha256: string;
  metadata?: Record<string, unknown>;
}

export interface RunAttemptInput {
  id: string;
  runId: string;
  attemptNumber: number;
  workerId: string;
  runtimeKind: RuntimeKind;
  runtimeMode: RuntimePermissionValue;
  runtimeModel?: RuntimeModel;
  permissionProfile: Record<string, unknown>;
  credentialStrategy: "provider_proxy" | "direct_env_proven";
  cliVersion?: string;
  providerSession?: Record<string, unknown>;
}

export class RunRepository {
  constructor(private readonly client: PoolClient) {}

  async createRun(input: CreateRunInput): Promise<RunRecord> {
    const result = await this.client.query(
      `
        insert into runs (id, runtime_kind, runtime_mode, runtime_model, input_json, prompt_summary)
        values ($1, $2, $3, $4, $5::jsonb, $6)
        returning *
      `,
      [
        input.id,
        input.runtimeKind,
        input.runtimeMode,
        input.runtimeModel,
        JSON.stringify(input.input),
        input.promptSummary
      ]
    );

    return mapRun(result.rows[0]);
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const result = await this.client.query(
      `
        select *
        from runs
        where id = $1
      `,
      [runId]
    );

    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  async listRuns(input: {
    status?: "active" | RunStatus;
    limit?: number;
  } = {}): Promise<RunRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const params: unknown[] = [limit];
    let where = "";

    if (input.status === "active") {
      where = "where status in ('queued', 'starting', 'running', 'cancelling')";
    } else if (input.status) {
      params.push(input.status);
      where = "where status = $2";
    }

    const result = await this.client.query(
      `
        select *
        from runs
        ${where}
        order by queued_at desc
        limit $1
      `,
      params
    );

    return result.rows.map(mapRun);
  }

  async updateRunStatus(
    runId: string,
    nextStatus: RunStatus,
    failure?: { code: string; reason: string }
  ): Promise<RunRecord> {
    const current = await this.getRun(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (current.status === nextStatus) {
      return current;
    }

    transitionRunStatus(current.status, nextStatus);
    const result = await this.client.query(
      `
        update runs
        set
          status = $2,
          started_at = case when $2 in ('starting', 'running') then coalesce(started_at, now()) else started_at end,
          completed_at = case when $2 in ('completed', 'failed', 'cancelled') then coalesce(completed_at, now()) else completed_at end,
          failure_code = coalesce($3, failure_code),
          failure_reason = coalesce($4, failure_reason)
        where id = $1
        returning *
      `,
      [runId, nextStatus, failure?.code, failure?.reason]
    );

    return mapRun(result.rows[0]);
  }

  async cancelRun(runId: string): Promise<RunRecord> {
    const current = await this.getRun(runId);
    if (!current) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (["completed", "failed", "cancelled"].includes(current.status)) {
      return current;
    }

    const result = await this.client.query(
      `
        update runs
        set status = 'cancelling', cancel_requested_at = coalesce(cancel_requested_at, now())
        where id = $1
        returning *
      `,
      [runId]
    );

    return mapRun(result.rows[0]);
  }

  async claimNextRun(workerId: string): Promise<RunRecord | undefined> {
    const result = await this.client.query(
      `
        with candidate as (
          select id
          from runs
          where status = 'queued'
          order by queued_at
          limit 1
          for update skip locked
        )
        update runs
        set status = 'starting', started_at = coalesce(started_at, now())
        from candidate
        where runs.id = candidate.id
        returning runs.*
      `
    );

    const run = result.rows[0] ? mapRun(result.rows[0]) : undefined;
    if (run) {
      await this.client.query(
        `
          insert into workers (id, status, last_heartbeat_at)
          values ($1, 'active', now())
          on conflict (id)
          do update set status = 'active', last_heartbeat_at = now()
        `,
        [workerId]
      );
    }

    return run;
  }

  async createRunAttempt(input: RunAttemptInput): Promise<void> {
    await this.client.query(
      `
        insert into run_attempts (
          id, run_id, attempt_number, worker_id, runtime_kind, runtime_mode, runtime_model,
          permission_profile_json, credential_strategy, cli_version, provider_session_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb)
      `,
      [
        input.id,
        input.runId,
        input.attemptNumber,
        input.workerId,
        input.runtimeKind,
        input.runtimeMode,
        input.runtimeModel,
        JSON.stringify(input.permissionProfile),
        input.credentialStrategy,
        input.cliVersion,
        JSON.stringify(input.providerSession ?? {})
      ]
    );
  }

  async recordSandboxSession(input: {
    id: string;
    runId: string;
    runAttemptId: string;
    provider: string;
    externalId: string;
    status: string;
    expiresAt?: Date;
  }): Promise<void> {
    await this.client.query(
      `
        insert into sandbox_sessions (
          id, run_id, run_attempt_id, provider, external_id, status, expires_at, last_heartbeat_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, now())
      `,
      [
        input.id,
        input.runId,
        input.runAttemptId,
        input.provider,
        input.externalId,
        input.status,
        input.expiresAt
      ]
    );
  }

  async appendEvent(input: AppendEventInput): Promise<EventRecord> {
    const normalized = normalizeEventPayload(input.payload, input.artifactRef);
    const sequenceResult = await this.client.query(
      `
        update runs
        set last_event_seq = last_event_seq + 1
        where id = $1
        returning last_event_seq
      `,
      [input.runId]
    );

    if (sequenceResult.rowCount !== 1) {
      throw new Error(`Run not found: ${input.runId}`);
    }

    const sequence = BigInt(sequenceResult.rows[0].last_event_seq);
    const result = await this.client.query(
      `
        insert into run_events (
          run_id, sequence, source, event_type, visibility,
          payload_json, payload_size_bytes, artifact_ref_json, is_truncated
        )
        values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9)
        returning created_at
      `,
      [
        input.runId,
        sequence.toString(),
        input.source,
        input.eventType,
        input.visibility,
        JSON.stringify(normalized.payload),
        normalized.payloadSizeBytes,
        JSON.stringify(normalized.artifactRef ?? {}),
        normalized.isTruncated
      ]
    );

    return {
      runId: input.runId,
      sequence,
      eventType: input.eventType,
      source: input.source,
      visibility: input.visibility,
      payload: normalized.payload,
      artifactRef: normalized.artifactRef,
      isTruncated: normalized.isTruncated,
      createdAt: result.rows[0]?.created_at ?? new Date()
    };
  }

  async listEvents(input: {
    runId: string;
    afterSeq?: bigint;
    limit?: number;
  }): Promise<EventRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const afterSeq = input.afterSeq ?? 0n;
    const result = await this.client.query(
      `
        select *
        from run_events
        where run_id = $1 and sequence > $2
        order by sequence asc
        limit $3
      `,
      [input.runId, afterSeq.toString(), limit]
    );

    return result.rows.map(mapEvent);
  }

  async recordArtifact(input: RecordArtifactInput): Promise<ArtifactRecord> {
    const result = await this.client.query(
      `
        insert into artifacts (
          id, run_id, run_attempt_id, kind, r2_key, content_type,
          size_bytes, sha256, metadata_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        returning *
      `,
      [
        input.id,
        input.runId,
        input.runAttemptId,
        input.kind,
        input.r2Key,
        input.contentType,
        input.sizeBytes.toString(),
        input.sha256,
        JSON.stringify(input.metadata ?? {})
      ]
    );

    return mapArtifact(result.rows[0]);
  }

  async listArtifacts(runId: string): Promise<ArtifactRecord[]> {
    const result = await this.client.query(
      `
        select *
        from artifacts
        where run_id = $1 and deleted_at is null
        order by created_at asc
      `,
      [runId]
    );

    return result.rows.map(mapArtifact);
  }

  async getArtifact(runId: string, artifactId: string): Promise<ArtifactRecord | undefined> {
    const result = await this.client.query(
      `
        select *
        from artifacts
        where run_id = $1 and id = $2 and deleted_at is null
      `,
      [runId, artifactId]
    );

    return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
  }
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    runtimeKind: row.runtime_kind as RuntimeKind,
    runtimeMode: row.runtime_mode as RuntimePermissionValue,
    runtimeModel: optionalString(row.runtime_model),
    status: row.status as RunStatus,
    lastEventSeq: BigInt(String(row.last_event_seq)),
    input: asRecord(row.input_json),
    promptSummary: String(row.prompt_summary ?? ""),
    queuedAt: row.queued_at as Date,
    startedAt: optionalDate(row.started_at),
    completedAt: optionalDate(row.completed_at),
    cancelRequestedAt: optionalDate(row.cancel_requested_at),
    failureCode: optionalString(row.failure_code),
    failureReason: optionalString(row.failure_reason)
  };
}

function mapEvent(row: Record<string, unknown>): EventRecord {
  const artifactRef = asRecord(row.artifact_ref_json);
  return {
    runId: String(row.run_id),
    sequence: BigInt(String(row.sequence)),
    eventType: String(row.event_type),
    source: String(row.source),
    visibility: row.visibility as EventRecord["visibility"],
    payload: asRecord(row.payload_json),
    artifactRef:
      typeof artifactRef.artifactId === "string" && typeof artifactRef.r2Key === "string"
        ? { artifactId: artifactRef.artifactId, r2Key: artifactRef.r2Key }
        : undefined,
    isTruncated: Boolean(row.is_truncated),
    createdAt: row.created_at as Date
  };
}

function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    runAttemptId: optionalString(row.run_attempt_id),
    kind: String(row.kind),
    r2Key: String(row.r2_key),
    contentType: optionalString(row.content_type),
    sizeBytes: BigInt(String(row.size_bytes)),
    sha256: String(row.sha256),
    metadata: asRecord(row.metadata_json),
    createdAt: row.created_at as Date
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}
