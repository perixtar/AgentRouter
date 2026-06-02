import { NextResponse } from "next/server";

import {
  AgentRouterApiError,
  connectProviderKey,
  listProviderKeys
} from "@/lib/agentrouter";
import { requirePrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const { items } = await listProviderKeys(principal.orgId);
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof AgentRouterApiError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { key?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) {
    return NextResponse.json({ error: "key_required" }, { status: 400 });
  }

  try {
    // Proxied to the Fly API which encrypts with the master key — the web
    // server NEVER encrypts or stores the plaintext.
    const result = await connectProviderKey(principal.orgId, { provider: "openai", key });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof AgentRouterApiError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.status }
      );
    }
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
}
