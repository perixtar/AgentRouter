import "server-only";

import { agentRouterApiUrl, webServiceToken } from "@/lib/env";

/**
 * Server-side client for the AgentRouter Fly API. Authenticates with the shared
 * web service token and asserts the caller's org via the X-AR-Org-Id header
 * (the refined decision #2). Never runs in the browser — the token stays on the
 * web server.
 */
function headers(orgId: string, withBody: boolean): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${webServiceToken()}`,
    "x-ar-org-id": orgId
  };
  // Only advertise a JSON body when there actually is one — Fastify rejects an
  // empty body sent with content-type: application/json (e.g. DELETE).
  if (withBody) h["content-type"] = "application/json";
  return h;
}

export interface ApiRun {
  id: string;
  status:
    | "queued"
    | "starting"
    | "running"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "failed";
  task: string;
  failure?: { code?: string; reason?: string };
  [key: string]: unknown;
}

export interface ApiEvent {
  runId: string;
  sequence: number;
  type: string;
  source: string;
  visibility: string;
  payload: Record<string, unknown>;
  artifactRef?: { artifactId: string; r2Key: string };
  createdAt: string;
}

export interface ApiArtifact {
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

export class AgentRouterApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

async function call<T>(
  orgId: string,
  path: string,
  init: RequestInit & { method: string }
): Promise<T> {
  const res = await fetch(`${agentRouterApiUrl()}${path}`, {
    ...init,
    headers: { ...headers(orgId, init.body != null), ...(init.headers ?? {}) },
    cache: "no-store"
  });

  if (!res.ok) {
    let code = "api_error";
    let message = `AgentRouter API ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON body; keep defaults
    }
    throw new AgentRouterApiError(res.status, code, message);
  }

  return (await res.json()) as T;
}

export function createRun(
  orgId: string,
  body: {
    task: string;
    runtime?: { kind: "codex"; mode?: string; model?: string };
  }
): Promise<ApiRun> {
  return call<ApiRun>(orgId, "/v1/runs", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

// ── sessions (M4) ──

export interface ApiSession {
  id: string;
  status: "active" | "closed";
  sandboxState: string;
  turnCount: number;
}

export function createSession(
  orgId: string,
  body: { runtime?: { kind: "codex"; mode?: string }; title?: string } = {}
): Promise<ApiSession> {
  return call<ApiSession>(orgId, "/v1/sessions", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function sendSessionMessage(
  orgId: string,
  sessionId: string,
  message: string
): Promise<{ runId: string; turnNumber: number; sessionId: string }> {
  return call(orgId, `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ message })
  });
}

export function listSessionEvents(
  orgId: string,
  sessionId: string,
  opts: { runId?: string; afterSeq?: number } = {}
): Promise<{
  sessionId: string;
  runId?: string;
  status?: ApiRun["status"];
  failure?: { code?: string; reason?: string };
  items: ApiEvent[];
  nextAfterSeq: number;
}> {
  const params = new URLSearchParams();
  if (opts.runId) params.set("runId", opts.runId);
  params.set("afterSeq", String(opts.afterSeq ?? 0));
  return call(
    orgId,
    `/v1/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`,
    { method: "GET" }
  );
}

export function getRun(orgId: string, runId: string): Promise<ApiRun> {
  return call<ApiRun>(orgId, `/v1/runs/${encodeURIComponent(runId)}`, {
    method: "GET"
  });
}

export function listEvents(
  orgId: string,
  runId: string,
  afterSeq: number
): Promise<{ items: ApiEvent[]; nextAfterSeq: number }> {
  return call(
    orgId,
    `/v1/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}&limit=500`,
    { method: "GET" }
  );
}

export function listArtifacts(
  orgId: string,
  runId: string
): Promise<{ items: ApiArtifact[] }> {
  return call(orgId, `/v1/runs/${encodeURIComponent(runId)}/artifacts`, {
    method: "GET"
  });
}

export async function downloadArtifact(
  orgId: string,
  runId: string,
  artifactId: string
): Promise<ArrayBuffer> {
  const res = await fetch(
    `${agentRouterApiUrl()}/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(
      artifactId
    )}/download`,
    { method: "GET", headers: headers(orgId, false), cache: "no-store" }
  );
  if (!res.ok) {
    throw new AgentRouterApiError(res.status, "artifact_download_failed", `Download ${res.status}`);
  }
  return res.arrayBuffer();
}

// ── BYOK provider keys (proxied so encryption stays on the API/Fly side) ──

export interface ProviderKeyStatus {
  provider: string;
  last4: string;
  connected: boolean;
  updatedAt?: string;
}

export function connectProviderKey(
  orgId: string,
  body: { provider: "openai"; key: string }
): Promise<{ provider: string; last4: string; connected: boolean }> {
  return call(orgId, "/v1/provider-keys", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

export function listProviderKeys(orgId: string): Promise<{ items: ProviderKeyStatus[] }> {
  return call(orgId, "/v1/provider-keys", { method: "GET" });
}

export function deleteProviderKey(
  orgId: string,
  provider: string
): Promise<{ provider: string; connected: boolean }> {
  return call(orgId, `/v1/provider-keys/${encodeURIComponent(provider)}`, {
    method: "DELETE"
  });
}
