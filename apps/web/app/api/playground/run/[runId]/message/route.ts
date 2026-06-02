import { NextResponse } from "next/server";

import { requirePrincipal } from "@/lib/auth";
import { AgentRouterError, sdkFor } from "@/lib/sdk";

export const dynamic = "force-dynamic";

/**
 * Continue a conversation by its run id (turn 2+). Uses the SDK's continueRun,
 * which auto-retries the brief post-completion `run_not_continuable` window
 * while the grace-park settles. Returns the new turn's run id to stream.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { runId } = await params;

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
    const turn = await sdkFor(principal.orgId).continueRun(runId, message);
    return NextResponse.json(
      { runId: turn.runId, turnNumber: turn.turnNumber, conversationId: turn.conversationId },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof AgentRouterError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode ?? 502 }
      );
    }
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
}
