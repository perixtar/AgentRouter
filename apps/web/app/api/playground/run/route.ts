import { NextResponse } from "next/server";

import { AgentRouterApiError, createRun } from "@/lib/agentrouter";
import { requirePrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { task?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const task = typeof body.task === "string" ? body.task.trim() : "";
  if (!task) {
    return NextResponse.json({ error: "task_required" }, { status: 400 });
  }

  try {
    // full_access: live file-creating runs hit nested-sandbox limits with codex
    // workspace-write inside Daytona; full_access is the working live path.
    const run = await createRun(principal.orgId, {
      task,
      runtime: { kind: "codex", mode: "full_access" }
    });
    return NextResponse.json({ runId: run.id, status: run.status }, { status: 201 });
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
