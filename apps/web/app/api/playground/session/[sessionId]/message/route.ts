import { NextResponse } from "next/server";

import { AgentRouterApiError, sendSessionMessage } from "@/lib/agentrouter";
import { requirePrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Sends a follow-up message into an existing session (a new turn). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { sessionId } = await params;

  let body: { message?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message_required" }, { status: 400 });
  }

  try {
    const turn = await sendSessionMessage(principal.orgId, sessionId, message);
    return NextResponse.json({ runId: turn.runId, turnNumber: turn.turnNumber }, { status: 202 });
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
