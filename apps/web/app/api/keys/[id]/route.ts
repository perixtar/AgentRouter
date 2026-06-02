import { NextResponse } from "next/server";

import { revokeApiKey } from "@/lib/api-keys";
import { requirePrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const revoked = await revokeApiKey(principal.orgId, id);
  if (!revoked) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ id, revoked: true });
}
