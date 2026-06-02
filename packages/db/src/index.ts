import { randomUUID } from "node:crypto";
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
    // ── Tenancy (M1): orgs, profiles, api_keys ──
    await client.query(`
      create table if not exists orgs (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        created_at timestamptz not null default now()
      )
    `);

    await client.query(`
      create table if not exists profiles (
        user_id uuid primary key,
        org_id uuid not null references orgs(id),
        email text not null,
        created_at timestamptz not null default now()
      )
    `);

    await client.query(`
      create table if not exists api_keys (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references orgs(id),
        name text not null,
        prefix text not null,
        key_hash text not null unique,
        scopes text[] not null default '{}',
        last_used_at timestamptz,
        revoked_at timestamptz,
        created_at timestamptz not null default now()
      )
    `);

    await client.query(
      "create index if not exists profiles_org_id_idx on profiles(org_id)"
    );
    await client.query(
      "create index if not exists api_keys_org_id_idx on api_keys(org_id)"
    );

    // ── BYOK (M3): provider_keys — encrypted at rest (AES-256-GCM). ──
    await client.query(`
      create table if not exists provider_keys (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references orgs(id),
        provider text not null,
        key_ciphertext bytea not null,
        key_iv bytea not null,
        key_tag bytea not null,
        key_last4 text not null,
        master_key_version integer not null default 1,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (org_id, provider)
      )
    `);

    // ── Multi-turn (M4): sessions own a persistent sandbox; turns map a user
    //    message → a run. ──
    await client.query(`
      create table if not exists sessions (
        id text primary key,
        org_id text not null,
        runtime_kind text not null default 'codex',
        runtime_mode text not null default 'full_access',
        runtime_model text,
        title text,
        sandbox_id text,
        sandbox_state text not null default 'none'
          check (sandbox_state in ('none', 'creating', 'running', 'suspended', 'deleting', 'deleted')),
        codex_session_id text,
        turn_count integer not null default 0,
        status text not null default 'active'
          check (status in ('active', 'closed')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_active_at timestamptz not null default now()
      )
    `);

    await client.query(`
      create table if not exists turns (
        id text primary key,
        session_id text not null references sessions(id),
        org_id text not null,
        run_id text not null,
        turn_number integer not null,
        prompt text not null,
        created_at timestamptz not null default now(),
        unique (session_id, turn_number)
      )
    `);

    await client.query("create index if not exists sessions_org_id_idx on sessions(org_id)");
    await client.query("create index if not exists turns_session_id_idx on turns(session_id)");

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
    // ── M2: tenant scoping on runtime tables (additive, nullable) ──
    await client.query("alter table runs add column if not exists org_id text");
    await client.query("alter table run_attempts add column if not exists org_id text");
    await client.query("create index if not exists runs_org_id_idx on runs(org_id)");
    // ── M4: a run may belong to a multi-turn session (null = one-shot). ──
    await client.query("alter table runs add column if not exists session_id text");
    // ── Run-id multi-turn (M1): the run that seeded a conversation (the public
    //    conversation handle) + an idle deadline the reaper enforces so a
    //    persistent sandbox can never linger past its TTL. ──
    await client.query("alter table sessions add column if not exists origin_run_id text");
    await client.query("alter table sessions add column if not exists idle_deadline_at timestamptz");
    await client.query("create index if not exists sessions_origin_run_id_idx on sessions(origin_run_id)");
    await client.query("drop index if exists sessions_reap_idx");
    await client.query(
      "create index if not exists sessions_reap_idx on sessions(idle_deadline_at) where sandbox_state = 'suspended'"
    );
    await client.query("create index if not exists runs_session_id_idx on runs(session_id)");
    // Allow the transient 'deleting' state the reaper uses while it claims a
    // sandbox for deletion (idempotent: drop the old check + re-add widened).
    await client.query(
      "alter table sessions drop constraint if exists sessions_sandbox_state_check"
    );
    await client.query(`
      do $$
      begin
        if not exists (
          select 1 from pg_constraint
          where conname = 'sessions_sandbox_state_check'
            and conrelid = 'sessions'::regclass
        ) then
          alter table sessions
          add constraint sessions_sandbox_state_check
          check (sandbox_state in ('none', 'creating', 'running', 'suspended', 'deleting', 'deleted'));
        end if;
      end
      $$;
    `);
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
  orgId?: string | null;
  sessionId?: string;
  runtimeKind: RuntimeKind;
  runtimeMode: RuntimePermissionValue;
  runtimeModel?: RuntimeModel;
  input: Record<string, unknown>;
  promptSummary: string;
}

export interface RunRecord {
  id: string;
  orgId?: string;
  sessionId?: string;
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
  providerEventType?: string;
  visibility: "public" | "internal" | "redacted";
  payload: Record<string, unknown>;
  artifactRef?: ArtifactRef;
}

export interface EventRecord {
  runId: string;
  sequence: bigint;
  eventType: string;
  providerEventType?: string;
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
  orgId?: string;
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
        insert into runs (id, org_id, session_id, runtime_kind, runtime_mode, runtime_model, input_json, prompt_summary)
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
        returning *
      `,
      [
        input.id,
        input.orgId,
        input.sessionId,
        input.runtimeKind,
        input.runtimeMode,
        input.runtimeModel,
        JSON.stringify(input.input),
        input.promptSummary
      ]
    );

    return mapRun(result.rows[0]);
  }

  // Tenant-isolation chokepoint: every run read is scoped to `orgId`. A run
  // belonging to another org is invisible (returns undefined) — never throws a
  // cross-tenant signal.
  async getRun(runId: string, orgId: string): Promise<RunRecord | undefined> {
    const result = await this.client.query(
      `
        select *
        from runs
        where id = $1 and org_id = $2
      `,
      [runId, orgId]
    );

    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  async listRuns(input: {
    orgId: string;
    status?: "active" | RunStatus;
    limit?: number;
  }): Promise<RunRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const params: unknown[] = [limit, input.orgId];
    let where = "where org_id = $2";

    if (input.status === "active") {
      where += " and status in ('queued', 'starting', 'running', 'cancelling')";
    } else if (input.status) {
      params.push(input.status);
      where += " and status = $3";
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

  // ── Trusted internal reads (worker only) ──
  // The worker operates on a run it has already claimed, so it does not assert
  // an org. These bypass the org filter intentionally and must NEVER be wired
  // to an API request path — the API uses the org-scoped variants above as the
  // tenant-isolation chokepoint.
  async getRunInternal(runId: string): Promise<RunRecord | undefined> {
    return this.getRunUnscoped(runId);
  }

  async listEventsInternal(input: {
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

  async listArtifactsInternal(runId: string): Promise<ArtifactRecord[]> {
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

  private async getRunUnscoped(runId: string): Promise<RunRecord | undefined> {
    const result = await this.client.query(
      `select * from runs where id = $1`,
      [runId]
    );
    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
  }

  async updateRunStatus(
    runId: string,
    nextStatus: RunStatus,
    failure?: { code: string; reason: string }
  ): Promise<RunRecord> {
    const current = await this.getRunUnscoped(runId);
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

  async cancelRun(runId: string, orgId: string): Promise<RunRecord | undefined> {
    const current = await this.getRun(runId, orgId);
    if (!current) {
      // Run not found for this org — caller maps to 404.
      return undefined;
    }

    if (["completed", "failed", "cancelled"].includes(current.status)) {
      return current;
    }

    const result = await this.client.query(
      `
        update runs
        set status = 'cancelling', cancel_requested_at = coalesce(cancel_requested_at, now())
        where id = $1 and org_id = $2
        returning *
      `,
      [runId, orgId]
    );

    return result.rows[0] ? mapRun(result.rows[0]) : undefined;
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
          id, run_id, org_id, attempt_number, worker_id, runtime_kind, runtime_mode, runtime_model,
          permission_profile_json, credential_strategy, cli_version, provider_session_json
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb)
      `,
      [
        input.id,
        input.runId,
        input.orgId,
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
          run_id, sequence, source, event_type, provider_event_type, visibility,
          payload_json, payload_size_bytes, artifact_ref_json, is_truncated
        )
        values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)
        returning created_at
      `,
      [
        input.runId,
        sequence.toString(),
        input.source,
        input.eventType,
        input.providerEventType,
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
      providerEventType: input.providerEventType,
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
    orgId: string;
    afterSeq?: bigint;
    limit?: number;
  }): Promise<EventRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const afterSeq = input.afterSeq ?? 0n;
    // Tenant-scoped: only events for a run owned by `orgId`.
    const result = await this.client.query(
      `
        select e.*
        from run_events e
        join runs r on r.id = e.run_id
        where e.run_id = $1 and r.org_id = $2 and e.sequence > $3
        order by e.sequence asc
        limit $4
      `,
      [input.runId, input.orgId, afterSeq.toString(), limit]
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

  async listArtifacts(runId: string, orgId: string): Promise<ArtifactRecord[]> {
    const result = await this.client.query(
      `
        select a.*
        from artifacts a
        join runs r on r.id = a.run_id
        where a.run_id = $1 and r.org_id = $2 and a.deleted_at is null
        order by a.created_at asc
      `,
      [runId, orgId]
    );

    return result.rows.map(mapArtifact);
  }

  async getArtifact(
    runId: string,
    artifactId: string,
    orgId: string
  ): Promise<ArtifactRecord | undefined> {
    const result = await this.client.query(
      `
        select a.*
        from artifacts a
        join runs r on r.id = a.run_id
        where a.run_id = $1 and a.id = $2 and r.org_id = $3 and a.deleted_at is null
      `,
      [runId, artifactId, orgId]
    );

    return result.rows[0] ? mapArtifact(result.rows[0]) : undefined;
  }

  // ── BYOK provider keys (M3) ──
  // Plaintext never touches these methods — only encrypted material in, and
  // (for the worker) encrypted material out to be decrypted with the master key.

  async upsertProviderKey(input: {
    orgId: string;
    provider: string;
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
    last4: string;
    keyVersion: number;
  }): Promise<void> {
    await this.client.query(
      `
        insert into provider_keys
          (org_id, provider, key_ciphertext, key_iv, key_tag, key_last4, master_key_version)
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (org_id, provider) do update set
          key_ciphertext = excluded.key_ciphertext,
          key_iv = excluded.key_iv,
          key_tag = excluded.key_tag,
          key_last4 = excluded.key_last4,
          master_key_version = excluded.master_key_version,
          updated_at = now()
      `,
      [
        input.orgId,
        input.provider,
        input.ciphertext,
        input.iv,
        input.tag,
        input.last4,
        input.keyVersion
      ]
    );
  }

  /** Returns the encrypted row for the worker to decrypt, or undefined. */
  async getProviderKey(
    orgId: string,
    provider: string
  ): Promise<ProviderKeyRecord | undefined> {
    const result = await this.client.query(
      `
        select org_id, provider, key_ciphertext, key_iv, key_tag, key_last4, master_key_version
        from provider_keys
        where org_id = $1 and provider = $2
      `,
      [orgId, provider]
    );
    return result.rows[0] ? mapProviderKey(result.rows[0]) : undefined;
  }

  /** Connection status for the UI — last4 only, never the secret. */
  async getProviderKeyStatus(orgId: string): Promise<ProviderKeyStatus[]> {
    const result = await this.client.query(
      `
        select provider, key_last4, updated_at
        from provider_keys
        where org_id = $1
        order by provider asc
      `,
      [orgId]
    );
    return result.rows.map((row) => ({
      provider: String(row.provider),
      last4: String(row.key_last4),
      updatedAt: row.updated_at as Date
    }));
  }

  async deleteProviderKey(orgId: string, provider: string): Promise<boolean> {
    const result = await this.client.query(
      `delete from provider_keys where org_id = $1 and provider = $2`,
      [orgId, provider]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ── AgentRouter API keys (M3) ──
  // The web server can manage these directly (no master key needed — only a
  // sha256 hash is stored).

  async createApiKey(input: {
    orgId: string;
    name: string;
    prefix: string;
    keyHash: string;
    scopes: string[];
  }): Promise<ApiKeyRecord> {
    const result = await this.client.query(
      `
        insert into api_keys (org_id, name, prefix, key_hash, scopes)
        values ($1, $2, $3, $4, $5)
        returning id, name, prefix, scopes, last_used_at, revoked_at, created_at
      `,
      [input.orgId, input.name, input.prefix, input.keyHash, input.scopes]
    );
    return mapApiKey(result.rows[0]);
  }

  async listApiKeys(orgId: string): Promise<ApiKeyRecord[]> {
    const result = await this.client.query(
      `
        select id, name, prefix, scopes, last_used_at, revoked_at, created_at
        from api_keys
        where org_id = $1
        order by created_at desc
      `,
      [orgId]
    );
    return result.rows.map(mapApiKey);
  }

  /** Soft-revoke (sets revoked_at). Org-scoped. Returns false if not found. */
  async revokeApiKey(orgId: string, id: string): Promise<boolean> {
    const result = await this.client.query(
      `
        update api_keys
        set revoked_at = now()
        where id = $1 and org_id = $2 and revoked_at is null
      `,
      [id, orgId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  // ── Multi-turn sessions (M4) — all org-scoped. ──

  async createSession(input: {
    id: string;
    orgId: string;
    runtimeKind: RuntimeKind;
    runtimeMode: RuntimePermissionValue;
    runtimeModel?: RuntimeModel;
    title?: string;
  }): Promise<SessionRecord> {
    const result = await this.client.query(
      `
        insert into sessions (id, org_id, runtime_kind, runtime_mode, runtime_model, title)
        values ($1, $2, $3, $4, $5, $6)
        returning *
      `,
      [
        input.id,
        input.orgId,
        input.runtimeKind,
        input.runtimeMode,
        input.runtimeModel,
        input.title
      ]
    );
    return mapSession(result.rows[0]);
  }

  async getSession(sessionId: string, orgId: string): Promise<SessionRecord | undefined> {
    const result = await this.client.query(
      `select * from sessions where id = $1 and org_id = $2`,
      [sessionId, orgId]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  /** Trusted internal read (worker) — not org-scoped. */
  async getSessionInternal(sessionId: string): Promise<SessionRecord | undefined> {
    const result = await this.client.query(`select * from sessions where id = $1`, [sessionId]);
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async listSessions(orgId: string, limit = 50): Promise<SessionRecord[]> {
    const result = await this.client.query(
      `select * from sessions where org_id = $1 order by last_active_at desc limit $2`,
      [orgId, Math.min(Math.max(limit, 1), 100)]
    );
    return result.rows.map(mapSession);
  }

  /**
   * Atomically claims a session for a new turn iff it has no in-flight turn.
   * Returns the session when claimed, or undefined when busy/closed/missing.
   * Concurrency guard: a 2nd in-flight turn for the same session is rejected.
   */
  async beginSessionTurn(sessionId: string, orgId: string): Promise<SessionRecord | undefined> {
    const result = await this.client.query(
      `
        update sessions
        set sandbox_state = case when sandbox_state = 'none' then 'creating' else sandbox_state end,
            last_active_at = now(),
            updated_at = now()
        where id = $1 and org_id = $2 and status = 'active'
          and not exists (
            select 1 from runs r
            where r.session_id = sessions.id
              and r.status in ('queued', 'starting', 'running', 'cancelling')
          )
        returning *
      `,
      [sessionId, orgId]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  async updateSessionSandbox(input: {
    sessionId: string;
    sandboxId?: string | null;
    sandboxState?: SessionRecord["sandboxState"];
    codexSessionId?: string | null;
  }): Promise<void> {
    await this.client.query(
      `
        update sessions
        set sandbox_id = coalesce($2, sandbox_id),
            sandbox_state = coalesce($3, sandbox_state),
            codex_session_id = coalesce($4, codex_session_id),
            updated_at = now(),
            last_active_at = now()
        where id = $1
      `,
      [input.sessionId, input.sandboxId ?? null, input.sandboxState ?? null, input.codexSessionId ?? null]
    );
  }

  async incrementSessionTurnCount(sessionId: string): Promise<void> {
    await this.client.query(
      `update sessions set turn_count = turn_count + 1, updated_at = now() where id = $1`,
      [sessionId]
    );
  }

  /** Sets the display turn counter to an absolute value (number of turns started). */
  async setSessionTurnCount(sessionId: string, count: number): Promise<void> {
    await this.client.query(
      `update sessions set turn_count = $2, updated_at = now() where id = $1`,
      [sessionId, count]
    );
  }

  /**
   * Resets a session to a clean pre-sandbox state (sandbox_id null,
   * sandbox_state 'none') after a turn fails before any sandbox is created —
   * only when no persistent sandbox exists yet, so the next message starts
   * fresh. Never downgrades a session that already owns a sandbox.
   */
  async resetSessionSandbox(sessionId: string): Promise<void> {
    await this.client.query(
      `update sessions
          set sandbox_id = null, sandbox_state = 'none', updated_at = now()
        where id = $1 and sandbox_id is null`,
      [sessionId]
    );
  }

  async closeSession(sessionId: string, orgId: string): Promise<SessionRecord | undefined> {
    const result = await this.client.query(
      `update sessions set status = 'closed', updated_at = now()
         where id = $1 and org_id = $2 returning *`,
      [sessionId, orgId]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  /**
   * Next turn number = max(turn_number)+1 for the session, derived from the
   * actual turns rows (NOT the display `turn_count`, which a failed turn can
   * leave stale). Must be called inside the same transaction as createTurn so
   * the value is consistent under concurrency.
   */
  async nextTurnNumber(sessionId: string): Promise<number> {
    const result = await this.client.query<{ next: number }>(
      `select coalesce(max(turn_number), 0) + 1 as next from turns where session_id = $1`,
      [sessionId]
    );
    return Number(result.rows[0]?.next ?? 1);
  }

  async createTurn(input: {
    id: string;
    sessionId: string;
    orgId: string;
    runId: string;
    turnNumber: number;
    prompt: string;
  }): Promise<TurnRecord> {
    const result = await this.client.query(
      `
        insert into turns (id, session_id, org_id, run_id, turn_number, prompt)
        values ($1, $2, $3, $4, $5, $6)
        returning *
      `,
      [input.id, input.sessionId, input.orgId, input.runId, input.turnNumber, input.prompt]
    );
    return mapTurn(result.rows[0]);
  }

  async listTurns(sessionId: string, orgId: string): Promise<TurnRecord[]> {
    const result = await this.client.query(
      `select * from turns where session_id = $1 and org_id = $2 order by turn_number asc`,
      [sessionId, orgId]
    );
    return result.rows.map(mapTurn);
  }

  // ── Run-id multi-turn (M1) ──

  /**
   * Resolves a run id to its conversation session (org-scoped). A run reaches
   * a session either by being a turn (`runs.session_id`) or by being the
   * conversation handle (`sessions.origin_run_id`). Returns undefined when the
   * run isn't part of a conversation yet.
   */
  async findSessionByRunId(runId: string, orgId: string): Promise<SessionRecord | undefined> {
    const result = await this.client.query(
      `
        select s.* from sessions s
        where s.org_id = $2
          and (
            s.origin_run_id = $1
            or s.id = (select r.session_id from runs r where r.id = $1 and r.org_id = $2)
          )
        limit 1
      `,
      [runId, orgId]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  /**
   * Promotes a finished one-shot run into a conversation: creates the session
   * keyed by the run (origin_run_id = runId), back-links the run, and records
   * turn #1 — all in the caller's transaction. The persistent sandbox + Codex
   * thread it parked carry over so a within-grace continuation truly resumes.
   * Idempotent: if the run already has a session, returns it unchanged.
   */
  async promoteRunToSession(input: {
    sessionId: string;
    runId: string;
    orgId: string;
    runtimeKind: RuntimeKind;
    runtimeMode: RuntimePermissionValue;
    runtimeModel?: RuntimeModel;
    prompt: string;
    sandboxId: string;
    codexSessionId?: string;
    sandboxState: SessionRecord["sandboxState"];
    idleDeadlineAt: Date;
  }): Promise<SessionRecord> {
    const existing = await this.findSessionByRunIdInternal(input.runId);
    if (existing) return existing;

    const result = await this.client.query(
      `
        insert into sessions
          (id, org_id, runtime_kind, runtime_mode, runtime_model, origin_run_id,
           sandbox_id, sandbox_state, codex_session_id, turn_count, idle_deadline_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10)
        returning *
      `,
      [
        input.sessionId,
        input.orgId,
        input.runtimeKind,
        input.runtimeMode,
        input.runtimeModel,
        input.runId,
        input.sandboxId,
        input.sandboxState,
        input.codexSessionId,
        input.idleDeadlineAt
      ]
    );
    await this.client.query(`update runs set session_id = $1 where id = $2`, [
      input.sessionId,
      input.runId
    ]);
    await this.client.query(
      `insert into turns (id, session_id, org_id, run_id, turn_number, prompt)
         values ($1, $2, $3, $4, 1, $5)
       on conflict (session_id, turn_number) do nothing`,
      [`turn_${randomUUID()}`, input.sessionId, input.orgId, input.runId, input.prompt]
    );
    return mapSession(result.rows[0]);
  }

  /** Unscoped session lookup by handle/turn run id (worker-internal). */
  private async findSessionByRunIdInternal(runId: string): Promise<SessionRecord | undefined> {
    const result = await this.client.query(
      `
        select s.* from sessions s
        where s.origin_run_id = $1
           or s.id = (select r.session_id from runs r where r.id = $1)
        limit 1
      `,
      [runId]
    );
    return result.rows[0] ? mapSession(result.rows[0]) : undefined;
  }

  /** Sets the reaper deadline + sandbox state for a parked session. */
  async setSessionIdleDeadline(input: {
    sessionId: string;
    idleDeadlineAt: Date;
    sandboxState?: SessionRecord["sandboxState"];
  }): Promise<void> {
    await this.client.query(
      `update sessions
          set idle_deadline_at = $2,
              sandbox_state = coalesce($3, sandbox_state),
              updated_at = now()
        where id = $1`,
      [input.sessionId, input.idleDeadlineAt, input.sandboxState ?? null]
    );
  }

  /**
   * Atomically claims sessions whose sandbox is past its idle deadline so the
   * reaper can delete them. `skip locked` + a status flip prevents two workers
   * from reaping the same one. Returns the claimed sessions (with sandbox_id).
   */
  async claimReapableSessions(limit = 10): Promise<SessionRecord[]> {
    const result = await this.client.query(
      `
        with candidates as (
          select id from sessions
          -- A suspended sandbox past its deadline is reclaimable whether the
          -- conversation is still active (idle TTL / grace expiry) or was closed
          -- by the client (/close arms an immediate-reclaim deadline).
          where status in ('active', 'closed')
            and sandbox_state = 'suspended'
            and idle_deadline_at is not null
            and idle_deadline_at < now()
            -- never reap a session with an in-flight turn (defensive).
            and not exists (
              select 1 from runs r
              where r.session_id = sessions.id
                and r.status in ('queued', 'starting', 'running', 'cancelling')
            )
          order by idle_deadline_at asc
          limit $1
          for update skip locked
        )
        update sessions s
        set sandbox_state = 'deleting', updated_at = now()
        from candidates c
        where s.id = c.id
        returning s.*
      `,
      [Math.min(Math.max(limit, 1), 50)]
    );
    return result.rows.map(mapSession);
  }

  /** Finalizes a reaped session after its sandbox is deleted. */
  async markSessionSandboxDeleted(sessionId: string): Promise<void> {
    await this.client.query(
      `update sessions
          set sandbox_state = 'deleted', status = 'closed',
              idle_deadline_at = null, updated_at = now()
        where id = $1`,
      [sessionId]
    );
  }
}

export interface SessionRecord {
  id: string;
  orgId: string;
  runtimeKind: RuntimeKind;
  runtimeMode: RuntimePermissionValue;
  runtimeModel?: RuntimeModel;
  title?: string;
  sandboxId?: string;
  sandboxState: "none" | "creating" | "running" | "suspended" | "deleting" | "deleted";
  codexSessionId?: string;
  turnCount: number;
  status: "active" | "closed";
  /** The run that seeded this conversation (the public conversation handle). */
  originRunId?: string;
  /** When the reaper may delete the parked sandbox (null = not parked). */
  idleDeadlineAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  lastActiveAt: Date;
}

export interface TurnRecord {
  id: string;
  sessionId: string;
  orgId: string;
  runId: string;
  turnNumber: number;
  prompt: string;
  createdAt: Date;
}

function mapSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    runtimeKind: row.runtime_kind as RuntimeKind,
    runtimeMode: row.runtime_mode as RuntimePermissionValue,
    runtimeModel: optionalString(row.runtime_model),
    title: optionalString(row.title),
    sandboxId: optionalString(row.sandbox_id),
    sandboxState: String(row.sandbox_state) as SessionRecord["sandboxState"],
    codexSessionId: optionalString(row.codex_session_id),
    turnCount: Number(row.turn_count),
    status: String(row.status) as SessionRecord["status"],
    originRunId: optionalString(row.origin_run_id),
    idleDeadlineAt: optionalDate(row.idle_deadline_at),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lastActiveAt: row.last_active_at as Date
  };
}

function mapTurn(row: Record<string, unknown>): TurnRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    orgId: String(row.org_id),
    runId: String(row.run_id),
    turnNumber: Number(row.turn_number),
    prompt: String(row.prompt),
    createdAt: row.created_at as Date
  };
}

export interface ProviderKeyRecord {
  orgId: string;
  provider: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  last4: string;
  keyVersion: number;
}

export interface ProviderKeyStatus {
  provider: string;
  last4: string;
  updatedAt: Date;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
}

function mapProviderKey(row: Record<string, unknown>): ProviderKeyRecord {
  return {
    orgId: String(row.org_id),
    provider: String(row.provider),
    ciphertext: row.key_ciphertext as Buffer,
    iv: row.key_iv as Buffer,
    tag: row.key_tag as Buffer,
    last4: String(row.key_last4),
    keyVersion: Number(row.master_key_version)
  };
}

function mapApiKey(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.prefix),
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    lastUsedAt: optionalDate(row.last_used_at),
    revokedAt: optionalDate(row.revoked_at),
    createdAt: row.created_at as Date
  };
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id),
    orgId: optionalString(row.org_id),
    sessionId: optionalString(row.session_id),
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
    providerEventType: optionalString(row.provider_event_type),
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
