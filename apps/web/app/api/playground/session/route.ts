import { NextResponse } from "next/server";

import {
  AgentRouterApiError,
  createSession,
  sendSessionMessage
} from "@/lib/agentrouter";
import { requirePrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * Starts a multi-turn session and submits the first message. Returns the
 * sessionId + the first turn's runId so the client can stream it.
 */
export async function POST(request: Request) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
    // full_access: live file-creating runs need it inside Daytona (see M2 note).
    const session = await createSession(principal.orgId, {
      runtime: { kind: "codex", mode: "full_access" }
    });
    const turn = await sendSessionMessage(principal.orgId, session.id, message);
    return NextResponse.json(
      { sessionId: session.id, runId: turn.runId, turnNumber: turn.turnNumber },
      { status: 201 }
    );
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
