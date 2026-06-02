import "server-only";

import { agentRouterApiUrl, webServiceToken } from "@/lib/env";

/**
 * Thin server-side fetch for the AgentRouter API surfaces the SDK does NOT
 * cover yet — i.e. BYOK provider keys. Run/conversation traffic now goes
 * through the real `@agentrouter/sdk` (see `lib/sdk.ts`). The shared web
 * service token stays server-only and the org is asserted via X-AR-Org-Id.
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
