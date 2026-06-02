import { NextResponse } from "next/server";

import { requirePrincipal } from "@/lib/auth";
import { AgentRouterError, sdkFor } from "@/lib/sdk";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  const url = new URL(request.url);
  const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0") || 0;
  const sdk = sdkFor(principal.orgId);

  try {
    // Run status + new events since afterSeq, both org-scoped by the API.
    const [run, events] = await Promise.all([
      sdk.getRun(runId),
      sdk.listRunEvents(runId, { afterSeq, limit: 500 })
    ]);

    // Only forward client-visible streams to the Terminal / chat.
    const items = events.items
      .filter((e) => e.visibility === "public")
      .map((e) => ({
        sequence: e.sequence,
        type: e.type,
        source: e.source,
        text: typeof e.payload.text === "string" ? (e.payload.text as string) : undefined,
        payload: e.payload
      }));

    return NextResponse.json({
      status: run.status,
      failure: run.failure,
      items,
      nextAfterSeq: events.nextAfterSeq
    });
  } catch (error) {
    if (error instanceof AgentRouterError) {
      // 404 → run not found / not this org's. Surface as-is.
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode ?? 502 }
      );
    }
    return NextResponse.json({ error: "upstream_unavailable" }, { status: 502 });
  }
}
