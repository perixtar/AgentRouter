import { NextResponse } from "next/server";

import { AgentRouterApiError, deleteProviderKey } from "@/lib/agentrouter";
import { requirePrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { provider } = await params;
  try {
    const result = await deleteProviderKey(principal.orgId, provider);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AgentRouterApiError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
}
