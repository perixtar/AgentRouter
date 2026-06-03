export interface AgentRouterOptions {
  baseUrl?: string;
  apiKey: string;
  /** Extra headers sent on every request (merged before per-call headers). */
  defaultHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export type CodexRuntimeMode = "default" | "read_only" | "full_access" | "auto_review";
export type ClaudeCodePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

export interface CodexRuntimeSelection {
  kind: "codex";
  mode?: CodexRuntimeMode;
  model?: string;
}

export interface ClaudeCodeRuntimeSelection {
  kind: "claude_code";
  permissionMode?: ClaudeCodePermissionMode;
  model?: string;
}

export type RuntimeSelection = CodexRuntimeSelection | ClaudeCodeRuntimeSelection;

export type ResolvedRuntimeSelection =
  | (CodexRuntimeSelection & { mode: CodexRuntimeMode })
  | (ClaudeCodeRuntimeSelection & { permissionMode: ClaudeCodePermissionMode });

export interface CreateRunRequest {
  task: string;
  runtime?: RuntimeSelection;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface Run {
  id: string;
  status: "queued" | "starting" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
  runtime: ResolvedRuntimeSelection;
  task: string;
  input: Record<string, unknown>;
  lastEventSeq: number;
  /** Conversation this run belongs to (the first run's id). The run id is the handle. */
  conversationId?: string;
  /** Internal session id once the run has been continued; null for an uncontinued one-shot. */
  sessionId?: string | null;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelRequestedAt?: string;
  failure?: { code?: string; reason?: string };
}

export interface RunEvent {
  runId: string;
  sequence: number;
  type: string;
  providerEventType?: string;
  source: string;
  visibility: "public" | "internal" | "redacted";
  payload: Record<string, unknown>;
  artifactRef?: { artifactId: string; r2Key: string };
  isTruncated: boolean;
  createdAt: string;
}

export interface Artifact {
  id: string;
  runId: string;
  kind: string;
  r2Key: string;
  contentType?: string;
  sizeBytes: number;
  sha256: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentResponseTextPart {
  type: "text";
  text: string;
}

export interface AgentResponse {
  text: string;
  parts: AgentResponseTextPart[];
  provider?: string;
  providerEventType?: string;
}

export interface RunSession {
  run: Run;
  eventCursor: { lastEventSeq: number };
  response: AgentResponse | null;
  artifactManifest: Record<string, unknown>;
  artifacts: { items: Artifact[] };
}

export interface AgentRunResult {
  id: string;
  status: Run["status"];
  text: string;
  response: AgentResponse | null;
  run: Run;
  session: RunSession;
  eventCursor: RunSession["eventCursor"];
  artifactManifest: RunSession["artifactManifest"];
  artifacts: RunSession["artifacts"];
}

export type AgentStreamPart =
  | { type: "progress"; text: string; event: RunEvent }
  | { type: "message"; text: string; event: RunEvent }
  | { type: "text"; text: string; event: RunEvent }
  | { type: "error"; text: string; event: RunEvent }
  | { type: "done"; status: Run["status"]; event: RunEvent };

export interface CreateAndWaitRequest extends CreateRunRequest {
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onEvent?: (event: RunEvent) => void;
}

export interface CodexRuntimeOptions {
  mode?: CodexRuntimeMode;
  model?: string;
}

export interface ClaudeCodeRuntimeOptions {
  permissionMode?: ClaudeCodePermissionMode;
  model?: string;
}

// ── Run-id multi-turn (M1 API): the run id is the conversation handle. ──

export interface ContinueRunResult {
  /** The new turn's run id (stream this to follow the turn). */
  runId: string;
  turnNumber: number;
  /** The conversation handle (the first run's id). */
  conversationId: string;
}

export interface RunTurn {
  id: string;
  runId: string;
  turnNumber: number;
  prompt: string;
  createdAt: string;
}

export interface RunTurnsResult {
  conversationId: string;
  items: RunTurn[];
}

export interface CloseRunResult {
  closed: boolean;
  conversationId: string;
  reclaimed: boolean;
}

export interface AgentRouterClient {
  createRun(input: CreateRunRequest): Promise<Run>;
  listRuns(query?: { status?: string; limit?: number }): Promise<{ items: Run[] }>;
  getRun(runId: string): Promise<Run>;
  getRunSession(runId: string): Promise<RunSession>;
  listRunEvents(
    runId: string,
    query?: { afterSeq?: number; limit?: number }
  ): Promise<{ items: RunEvent[]; nextAfterSeq: number }>;
  cancelRun(runId: string): Promise<Run>;
  listRunArtifacts(runId: string): Promise<{ items: Artifact[] }>;
  downloadArtifact(runId: string, artifactId: string): Promise<ArrayBuffer>;
  streamRun(runId: string, options?: { afterSeq?: number }): AsyncGenerator<RunEvent>;
  createRunAndWait(input: CreateAndWaitRequest): Promise<RunSession>;
  // ── run-id multi-turn (M1): continue / inspect / close a conversation by run id ──
  continueRun(runId: string, message: string): Promise<ContinueRunResult>;
  getRunTurns(runId: string): Promise<RunTurnsResult>;
  closeRun(runId: string): Promise<CloseRunResult>;
}

export interface RunAgentCreateRequest extends CreateAndWaitRequest {
  client: AgentRouterClient;
  continueRun?: never;
  message?: never;
}

/**
 * Continue an existing conversation by run id and wait for the new turn to
 * finish. Pass the handle (the first run's) id as `continueRun` plus the
 * follow-up `message`. (Previously this took a `sessionId` that was actually a
 * runId and never sent a message — that broken shape has been removed.)
 */
export interface RunAgentResumeRequest {
  client: AgentRouterClient;
  continueRun: string;
  message: string;
  afterSeq?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onEvent?: (event: RunEvent) => void;
}

export type RunAgentRequest = RunAgentCreateRequest | RunAgentResumeRequest;

export interface StreamAgentCreateRequest extends CreateRunRequest {
  client: AgentRouterClient;
  continueRun?: never;
  message?: never;
  afterSeq?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface StreamAgentResumeRequest {
  client: AgentRouterClient;
  continueRun: string;
  message: string;
  afterSeq?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export type StreamAgentRequest = StreamAgentCreateRequest | StreamAgentResumeRequest;

interface StreamWaitOptions {
  afterSeq?: number;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

export interface AgentRunStream {
  run: Run;
  /** Stable conversation handle. For continued streams, this is the original run id. */
  conversationId: string;
  turnNumber?: number;
  events: AsyncGenerator<RunEvent>;
  fullStream: AsyncGenerator<AgentStreamPart>;
  textStream: AsyncGenerator<string>;
  finalResult: Promise<AgentRunResult>;
}

export function agentrouter(options: AgentRouterOptions): AgentRouterClient {
  return new AgentRouterClientImpl(options);
}

export function codex(options: CodexRuntimeOptions = {}): CodexRuntimeSelection {
  return { kind: "codex", ...options };
}

export function claudeCode(options: ClaudeCodeRuntimeOptions = {}): ClaudeCodeRuntimeSelection {
  return { kind: "claude_code", ...options };
}

export async function runAgent(input: RunAgentRequest): Promise<AgentRunResult> {
  if (isRunAgentResumeRequest(input)) {
    const { client, continueRun, message, afterSeq, pollIntervalMs, maxWaitMs, onEvent } = input;
    // Actually continue the conversation: send the follow-up, then wait for the
    // NEW turn's run to finish (not just re-wait on the old run).
    const { runId } = await client.continueRun(continueRun, message);
    const session = await waitForRun(client, runId, {
      afterSeq,
      pollIntervalMs,
      maxWaitMs,
      onEvent
    });
    return toAgentRunResult(session);
  }

  if (isRunAgentCreateRequest(input)) {
    const { client, ...request } = input;
    const session = await client.createRunAndWait(request);
    return toAgentRunResult(session);
  }

  throw new AgentRouterError(
    "invalid_run_agent_request",
    "runAgent requires either { task } to start or { continueRun, message } to continue"
  );
}

function isRunAgentResumeRequest(input: RunAgentRequest): input is RunAgentResumeRequest {
  return (
    "continueRun" in input &&
    typeof input.continueRun === "string" &&
    input.continueRun.length > 0 &&
    typeof input.message === "string"
  );
}

function isRunAgentCreateRequest(input: RunAgentRequest): input is RunAgentCreateRequest {
  return "task" in input && typeof input.task === "string";
}

function isCompletedContinuableCodexRun(run: Run): boolean {
  return (
    run.status === "completed" &&
    run.runtime.kind === "codex" &&
    ["default", "read_only", "full_access"].includes(run.runtime.mode)
  );
}

export async function streamAgent(input: StreamAgentRequest): Promise<AgentRunStream> {
  const { client, pollIntervalMs, maxWaitMs, afterSeq } = input;
  const streamOptions = { afterSeq, pollIntervalMs, maxWaitMs };

  if (isStreamAgentResumeRequest(input)) {
    const { runId, turnNumber, conversationId } = await client.continueRun(
      input.continueRun,
      input.message
    );
    const run = await client.getRun(runId);
    return {
      run,
      conversationId,
      turnNumber,
      events: streamRunEventsUntilTerminal(client, runId, streamOptions),
      fullStream: streamRunPartsUntilTerminal(client, runId, streamOptions),
      textStream: streamRunTextUntilTerminal(client, runId, streamOptions),
      finalResult: waitForRun(client, runId, streamOptions).then(toAgentRunResult)
    };
  }

  if (isStreamAgentCreateRequest(input)) {
    const { task, runtime, metadata, idempotencyKey } = input;
    const request: CreateRunRequest = { task, runtime, metadata, idempotencyKey };
    const run = await client.createRun(request);
    return {
      run,
      conversationId: run.conversationId ?? run.id,
      events: streamRunEventsUntilTerminal(client, run.id, streamOptions),
      fullStream: streamRunPartsUntilTerminal(client, run.id, streamOptions),
      textStream: streamRunTextUntilTerminal(client, run.id, streamOptions),
      finalResult: waitForRun(client, run.id, streamOptions).then(toAgentRunResult)
    };
  }

  throw new AgentRouterError(
    "invalid_stream_agent_request",
    "streamAgent requires either { task } to start or { continueRun, message } to continue"
  );
}

function isStreamAgentResumeRequest(input: StreamAgentRequest): input is StreamAgentResumeRequest {
  return (
    "continueRun" in input &&
    typeof input.continueRun === "string" &&
    input.continueRun.length > 0 &&
    typeof input.message === "string"
  );
}

function isStreamAgentCreateRequest(input: StreamAgentRequest): input is StreamAgentCreateRequest {
  return "task" in input && typeof input.task === "string";
}

class AgentRouterClientImpl implements AgentRouterClient {
  private readonly http: AgentRouterHttpClient;

  constructor(options: AgentRouterOptions) {
    this.http = new AgentRouterHttpClient(options);
  }

  async createRun(input: CreateRunRequest): Promise<Run> {
    return this.http.create(input);
  }

  async listRuns(query: { status?: string; limit?: number } = {}): Promise<{ items: Run[] }> {
    return this.http.list(query);
  }

  async getRun(runId: string): Promise<Run> {
    return this.http.get(runId);
  }

  async getRunSession(runId: string): Promise<RunSession> {
    return this.http.session(runId);
  }

  async listRunEvents(
    runId: string,
    query: { afterSeq?: number; limit?: number } = {}
  ): Promise<{ items: RunEvent[]; nextAfterSeq: number }> {
    return this.http.events(runId, query);
  }

  async cancelRun(runId: string): Promise<Run> {
    return this.http.cancel(runId);
  }

  async listRunArtifacts(runId: string): Promise<{ items: Artifact[] }> {
    return this.http.artifacts(runId);
  }

  async downloadArtifact(runId: string, artifactId: string): Promise<ArrayBuffer> {
    return this.http.downloadArtifact(runId, artifactId);
  }

  streamRun(runId: string, options: { afterSeq?: number } = {}): AsyncGenerator<RunEvent> {
    return this.http.stream(runId, options);
  }

  async createRunAndWait(input: CreateAndWaitRequest): Promise<RunSession> {
    return this.http.createAndWait(input);
  }

  // ── run-id multi-turn (M1) ──
  async continueRun(runId: string, message: string): Promise<ContinueRunResult> {
    // A run becomes continuable the instant its grace-park (suspend + promote
    // to a conversation) settles — which lands just after the run reports
    // `completed`. Continuing immediately can race that window and get a
    // transient `run_not_continuable`. Retry briefly (only that code, only
    // while the run is terminal) so the common "continue right after a turn"
    // flow is reliable, without masking a genuinely non-continuable run.
    const deadline = Date.now() + 8000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.http.continueRun(runId, message);
      } catch (error) {
        const retriable =
          error instanceof AgentRouterError &&
          error.code === "run_not_continuable" &&
          Date.now() < deadline;
        if (!retriable) throw error;
        await sleep(Math.min(250 * (attempt + 1), 1000));
      }
    }
  }

  async getRunTurns(runId: string): Promise<RunTurnsResult> {
    return this.http.getRunTurns(runId);
  }

  async closeRun(runId: string): Promise<CloseRunResult> {
    // Closing immediately after a successful one-shot Codex run can race the
    // worker's grace-park promotion. In that narrow window the API has the run
    // but not yet the session, so it returns reclaimed:false. Retry briefly for
    // completed continuable Codex runs; return immediately for truly
    // non-continuable runtimes or once the deadline is exhausted.
    const deadline = Date.now() + 8000;
    for (let attempt = 0; ; attempt++) {
      const result = await this.http.closeRun(runId);
      if (result.reclaimed || Date.now() >= deadline) return result;

      let run: Run;
      try {
        run = await this.http.get(runId);
      } catch {
        return result;
      }
      if (!isCompletedContinuableCodexRun(run)) return result;

      await sleep(Math.min(250 * (attempt + 1), 1000));
    }
  }

}

class AgentRouterHttpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseHeaders: Record<string, string>;

  constructor(options: AgentRouterOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseHeaders = { ...(options.defaultHeaders ?? {}) };
  }

  async create(input: CreateRunRequest): Promise<Run> {
    const { idempotencyKey, ...body } = input;
    return this.request<Run>("/v1/runs", {
      method: "POST",
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
      body
    });
  }

  async list(query: { status?: string; limit?: number } = {}): Promise<{ items: Run[] }> {
    const params = new URLSearchParams();
    if (query.status) params.set("status", query.status);
    if (query.limit) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<{ items: Run[] }>(`/v1/runs${suffix}`);
  }

  async get(runId: string): Promise<Run> {
    return this.request<Run>(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  async session(runId: string): Promise<RunSession> {
    return this.request<RunSession>(`/v1/runs/${encodeURIComponent(runId)}/session`);
  }

  async events(
    runId: string,
    query: { afterSeq?: number; limit?: number } = {}
  ): Promise<{ items: RunEvent[]; nextAfterSeq: number }> {
    const params = new URLSearchParams();
    if (query.afterSeq !== undefined) params.set("afterSeq", String(query.afterSeq));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<{ items: RunEvent[]; nextAfterSeq: number }>(
      `/v1/runs/${encodeURIComponent(runId)}/events${suffix}`
    );
  }

  async cancel(runId: string): Promise<Run> {
    return this.request<Run>(`/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: {}
    });
  }

  // ── run-id multi-turn (M1) ──
  async continueRun(runId: string, message: string): Promise<ContinueRunResult> {
    return this.request<ContinueRunResult>(`/v1/runs/${encodeURIComponent(runId)}/messages`, {
      method: "POST",
      body: { message }
    });
  }

  async getRunTurns(runId: string): Promise<RunTurnsResult> {
    return this.request<RunTurnsResult>(`/v1/runs/${encodeURIComponent(runId)}/turns`);
  }

  async closeRun(runId: string): Promise<CloseRunResult> {
    return this.request<CloseRunResult>(`/v1/runs/${encodeURIComponent(runId)}/close`, {
      method: "POST",
      body: {}
    });
  }

  async artifacts(runId: string): Promise<{ items: Artifact[] }> {
    return this.request<{ items: Artifact[] }>(`/v1/runs/${encodeURIComponent(runId)}/artifacts`);
  }

  async downloadArtifact(runId: string, artifactId: string): Promise<ArrayBuffer> {
    const response = await this.rawRequest(
      `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/download`
    );
    return response.arrayBuffer();
  }

  async *stream(runId: string, options: { afterSeq?: number } = {}): AsyncGenerator<RunEvent> {
    const params = new URLSearchParams();
    if (options.afterSeq !== undefined) params.set("afterSeq", String(options.afterSeq));
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    const response = await this.rawRequest(`/v1/runs/${encodeURIComponent(runId)}/stream${suffix}`);
    const body = await response.text();

    for (const event of parseSseEvents(body)) {
      if (event.event === "heartbeat") continue;
      yield JSON.parse(event.data) as RunEvent;
    }
  }

  async createAndWait(input: CreateAndWaitRequest): Promise<RunSession> {
    const { pollIntervalMs = 1000, maxWaitMs = 10 * 60 * 1000, onEvent, ...createInput } = input;
    const run = await this.create(createInput);
    let afterSeq = 0;
    const startedAt = Date.now();

    for (;;) {
      const eventPage = await this.events(run.id, { afterSeq, limit: 500 });
      for (const event of eventPage.items) {
        afterSeq = event.sequence;
        onEvent?.(event);
      }

      const current = await this.get(run.id);
      if (["completed", "failed", "cancelled"].includes(current.status)) {
        if (afterSeq < current.lastEventSeq) {
          if (eventPage.items.length === 0) await sleep(pollIntervalMs);
          continue;
        }
        return this.session(run.id);
      }

      if (Date.now() - startedAt >= maxWaitMs) {
        throw new AgentRouterError("wait_timeout", "Run did not reach a terminal state before maxWaitMs", {
          runId: run.id,
          status: current.status
        });
      }

      await sleep(pollIntervalMs);
    }
  }

  private async request<T>(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
  ): Promise<T> {
    const response = await this.rawRequest(path, options);
    return (await response.json()) as T;
  }

  private async rawRequest(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
  ): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...this.baseHeaders,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        ...options.headers
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    if (!response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      const error = asErrorPayload(payload);
      throw new AgentRouterError(error.code, error.message, error.details, response.status);
    }

    return response;
  }
}

export class AgentRouterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly statusCode?: number
  ) {
    super(message);
  }
}

/**
 * Polls a run by its id until it reaches a terminal state, then returns its
 * RunSession snapshot. (Honest name: the parameter is a runId — it does NOT
 * send any message. To continue a conversation, call `client.continueRun` /
 * `runAgent({ continueRun, message })`.)
 */
async function waitForRun(
  client: AgentRouterClient,
  runId: string,
  options: {
    afterSeq?: number;
    pollIntervalMs?: number;
    maxWaitMs?: number;
    onEvent?: (event: RunEvent) => void;
  } = {}
): Promise<RunSession> {
  const { pollIntervalMs = 1000, maxWaitMs = 10 * 60 * 1000, onEvent } = options;
  let afterSeq = options.afterSeq ?? 0;
  const startedAt = Date.now();

  for (;;) {
    const eventPage = await client.listRunEvents(runId, { afterSeq, limit: 500 });
    for (const event of eventPage.items) {
      afterSeq = event.sequence;
      onEvent?.(event);
    }

    const current = await client.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(current.status)) {
      if (afterSeq < current.lastEventSeq) {
        if (eventPage.items.length === 0) await sleep(pollIntervalMs);
        continue;
      }
      return client.getRunSession(runId);
    }

    if (Date.now() - startedAt >= maxWaitMs) {
      throw new AgentRouterError("wait_timeout", "Run did not reach a terminal state before maxWaitMs", {
        runId,
        status: current.status
      });
    }

    await sleep(pollIntervalMs);
  }
}

function toAgentRunResult(session: RunSession): AgentRunResult {
  return {
    id: session.run.id,
    status: session.run.status,
    text: session.response?.text ?? "",
    response: session.response,
    run: session.run,
    session,
    eventCursor: session.eventCursor,
    artifactManifest: session.artifactManifest,
    artifacts: session.artifacts
  };
}

async function* streamRunTextUntilTerminal(
  client: AgentRouterClient,
  runId: string,
  options: StreamWaitOptions = {}
): AsyncGenerator<string> {
  for await (const event of streamRunEventsUntilTerminal(client, runId, options)) {
    const text = textFromAgentResponseEvent(event);
    if (text) yield text;
  }
}

async function* streamRunPartsUntilTerminal(
  client: AgentRouterClient,
  runId: string,
  options: StreamWaitOptions = {}
): AsyncGenerator<AgentStreamPart> {
  for await (const event of streamRunEventsUntilTerminal(client, runId, options)) {
    const part = streamPartFromRunEvent(event);
    if (part) yield part;
  }
}

function textFromAgentResponseEvent(event: RunEvent): string | undefined {
  if (event.type !== "agent.response") return undefined;
  return typeof event.payload.text === "string" ? event.payload.text : undefined;
}

function streamPartFromRunEvent(event: RunEvent): AgentStreamPart | undefined {
  if (event.type === "agent.response") {
    const text = stringPayload(event, "text");
    return text ? { type: "text", text, event } : undefined;
  }

  if (event.type === "agent.message") {
    const text = stringPayload(event, "text");
    return text ? { type: "message", text, event } : undefined;
  }

  if (event.type === "agent.error" || event.type === "run.failed") {
    return {
      type: "error",
      text: stringPayload(event, "message") ?? stringPayload(event, "reason") ?? "Run failed",
      event
    };
  }

  if (event.type === "run.completed" || event.type === "run.cancelled") {
    return {
      type: "done",
      status: event.type === "run.cancelled" ? "cancelled" : "completed",
      event
    };
  }

  const progressText = progressTextFromEvent(event);
  return progressText ? { type: "progress", text: progressText, event } : undefined;
}

function progressTextFromEvent(event: RunEvent): string | undefined {
  if (event.type === "agent.progress") {
    return stringPayload(event, "summary") ?? stringPayload(event, "message");
  }

  if (event.type === "agent.started") return "Agent started";
  if (event.type === "sandbox.created") return "Sandbox ready";
  if (event.type === "credential_boundary.verified") return "Credential boundary verified";
  if (event.type === "workspace.file_index_collected") return "Workspace file index collected";
  if (event.type === "workspace.patch_collected") return "Workspace patch collected";
  return undefined;
}

function stringPayload(event: RunEvent, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function* streamRunEventsUntilTerminal(
  client: AgentRouterClient,
  runId: string,
  options: StreamWaitOptions = {}
): AsyncGenerator<RunEvent> {
  const { pollIntervalMs = 1000, maxWaitMs = 10 * 60 * 1000 } = options;
  let afterSeq = options.afterSeq ?? 0;
  const startedAt = Date.now();

  for (;;) {
    const eventPage = await client.listRunEvents(runId, { afterSeq, limit: 500 });
    for (const event of eventPage.items) {
      afterSeq = event.sequence;
      yield event;
    }

    const current = await client.getRun(runId);
    if (["completed", "failed", "cancelled"].includes(current.status)) {
      if (afterSeq < current.lastEventSeq) {
        if (eventPage.items.length === 0) await sleep(pollIntervalMs);
        continue;
      }
      return;
    }

    if (Date.now() - startedAt >= maxWaitMs) {
      throw new AgentRouterError("wait_timeout", "Run did not reach a terminal state before maxWaitMs", {
        runId,
        status: current.status
      });
    }

    await sleep(pollIntervalMs);
  }
}

function parseSseEvents(body: string): Array<{ event: string; data: string }> {
  return body
    .split(/\n\n+/)
    .map((chunk) => {
      const event = { event: "message", data: "" };
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) event.event = line.slice("event:".length).trim();
        if (line.startsWith("data:")) event.data += line.slice("data:".length).trim();
      }
      return event;
    })
    .filter((event) => event.data.length > 0);
}

function asErrorPayload(value: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (value && typeof value === "object" && "error" in value) {
    const error = (value as { error: Record<string, unknown> }).error;
    return {
      code: typeof error.code === "string" ? error.code : "api_error",
      message: typeof error.message === "string" ? error.message : "AgentRouter API error",
      details:
        error.details && typeof error.details === "object"
          ? (error.details as Record<string, unknown>)
          : undefined
    };
  }

  return { code: "api_error", message: "AgentRouter API error" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
