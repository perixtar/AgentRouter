import { NextResponse } from "next/server";

import { requirePrincipal } from "@/lib/auth";
import { AgentRouterError, sdkFor } from "@/lib/sdk";

export const dynamic = "force-dynamic";

interface FileEntry {
  status: string;
  path: string;
}

/** Maps a git porcelain status pair (e.g. "A ", " M", "??") to a single code. */
function statusCode(raw: string): "A" | "M" | "D" {
  const s = raw.trim();
  if (s.includes("D")) return "D";
  if (s.includes("A") || s === "??") return "A";
  return "M";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> }
) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  const sdk = sdkFor(principal.orgId);

  try {
    const { items } = await sdk.listRunArtifacts(runId);
    const fileIndex = items.find((a) => a.kind === "workspace_file_index");
    if (!fileIndex) {
      return NextResponse.json({ files: [], ready: false });
    }

    const bytes = await sdk.downloadArtifact(runId, fileIndex.id);
    const json = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
      files?: FileEntry[];
    };

    const files = (json.files ?? []).map((f) => ({
      code: statusCode(f.status),
      path: f.path
    }));

    return NextResponse.json({ files, ready: true });
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
