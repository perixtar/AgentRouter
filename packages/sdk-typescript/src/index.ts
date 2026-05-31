export interface AgentRouterOptions {
  baseUrl?: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface RuntimeSelection {
  kind: "codex" | "claude_code";
  mode?: "default" | "read_only" | "full_access" | "auto_review";
}

export interface GitSource {
  type: "git";
  repoUrl: string;
  branch?: string;
  baseRef?: string;
}

export interface ScratchSource {
  type: "scratch";
}

export interface CreateRunRequest {
  task: string;
  runtime?: RuntimeSelection;
  source?: GitSource | ScratchSource;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface Run {
  id: string;
  status: "queued" | "starting" | "running" | "cancelling" | "cancelled" | "completed" | "failed";
  runtime: Required<RuntimeSelection>;
  task: string;
  input: Record<string, unknown>;
  lastEventSeq: number;
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

export interface RunSession {
  run: Run;
  eventCursor: { lastEventSeq: number };
  artifactManifest: Record<string, unknown>;
  artifacts: { items: Artifact[] };
}

export interface CreateAndWaitRequest extends CreateRunRequest {
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onEvent?: (event: RunEvent) => void;
}

export class AgentRouter {
  readonly runs: RunsClient;

  constructor(options: AgentRouterOptions) {
    this.runs = new RunsClient(options);
  }
}

export class RunsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentRouterOptions) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
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
