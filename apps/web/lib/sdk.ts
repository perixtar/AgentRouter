import "server-only";

import { agentrouter, type AgentRouterClient } from "@agentrouter/sdk";

import { agentRouterApiUrl, webServiceToken } from "@/lib/env";

/**
 * Builds the real `@agentrouter/sdk` client scoped to an org. The web server
 * authenticates with the shared web service token and asserts the org via the
 * SDK's `orgId` option (M2) — which sends `X-AR-Org-Id` on every request, so
 * multi-tenant routing still works. Server-only: the service token never
 * reaches the browser.
 */
export function sdkFor(orgId: string): AgentRouterClient {
  return agentrouter({
    baseUrl: agentRouterApiUrl(),
    apiKey: webServiceToken(),
    orgId
  });
}

export { AgentRouterError } from "@agentrouter/sdk";
