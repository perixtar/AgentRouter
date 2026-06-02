import { NextResponse } from "next/server";

import { createApiKey, listApiKeys } from "@/lib/api-keys";
import { requirePrincipal } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const items = await listApiKeys(principal.orgId);
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const principal = await requirePrincipal();
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { name?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name_required" }, { status: 400 });
  }

  // Returns the plaintext secret exactly once.
  const created = await createApiKey({ orgId: principal.orgId, name });
  return NextResponse.json(created, { status: 201 });
}
