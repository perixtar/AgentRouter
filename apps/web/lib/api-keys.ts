import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { withSchema } from "@/lib/db";

/**
 * AgentRouter API keys (`ar_live_…`). The web server manages these directly —
 * only a sha256 hash + prefix are stored, so no master key is needed. The
 * plaintext secret is shown exactly once, at creation (reveal-once).
 */

const KEY_PREFIX = "ar_live_";
const DEFAULT_SCOPES = ["agents:run", "runs:read"];

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  secret: string; // full plaintext — returned ONLY at creation
  createdAt: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Generates, hashes, and stores a new key. Returns the plaintext once. */
export async function createApiKey(input: {
  orgId: string;
  name: string;
  scopes?: string[];
}): Promise<CreatedApiKey> {
  const random = randomBytes(24).toString("base64url"); // ~32 chars, url-safe
  const secret = `${KEY_PREFIX}${random}`;
  const prefix = secret.slice(0, KEY_PREFIX.length + 3); // ar_live_ + 3 chars
  const scopes = input.scopes?.length ? input.scopes : DEFAULT_SCOPES;
  const name = input.name.trim() || "Untitled key";

  const row = await withSchema((client) =>
    client.query<{ id: string; created_at: Date }>(
      `insert into api_keys (org_id, name, prefix, key_hash, scopes)
         values ($1, $2, $3, $4, $5)
       returning id, created_at`,
      [input.orgId, name, prefix, sha256(secret), scopes]
    )
  );

  return {
    id: row.rows[0]!.id,
    name,
    prefix,
    scopes,
    secret,
    createdAt: row.rows[0]!.created_at.toISOString()
  };
}

export async function listApiKeys(orgId: string): Promise<ApiKeySummary[]> {
  const res = await withSchema((client) =>
    client.query<{
      id: string;
      name: string;
      prefix: string;
      scopes: string[];
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>(
      `select id, name, prefix, scopes, last_used_at, revoked_at, created_at
         from api_keys
        where org_id = $1
        order by created_at desc`,
      [orgId]
    )
  );

  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: Array.isArray(r.scopes) ? r.scopes : [],
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
    revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    createdAt: r.created_at.toISOString()
  }));
}

/** Org-scoped soft-revoke. Returns false if not found / already revoked. */
export async function revokeApiKey(orgId: string, id: string): Promise<boolean> {
  const res = await withSchema((client) =>
    client.query(
      `update api_keys set revoked_at = now()
        where id = $1 and org_id = $2 and revoked_at is null`,
      [id, orgId]
    )
  );
  return (res.rowCount ?? 0) > 0;
}
