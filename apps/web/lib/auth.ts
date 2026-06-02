import "server-only";

import { ensureOrgAndProfile, getOrgIdForUser } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export interface RequestPrincipal {
  userId: string;
  email: string;
  orgId: string;
}

/**
 * Resolves the authenticated user and their org for a server route handler.
 * Returns null when there is no valid session (caller responds 401).
 * Provisions the org/profile defensively if somehow missing.
 */
export async function requirePrincipal(): Promise<RequestPrincipal | null> {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return null;

  const email = user.email ?? "";
  let orgId = await getOrgIdForUser(user.id);
  if (!orgId) {
    orgId = (await ensureOrgAndProfile({ userId: user.id, email })).orgId;
  }

  return { userId: user.id, email, orgId };
}
