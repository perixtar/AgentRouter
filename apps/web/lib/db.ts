import "server-only";

import { Pool } from "pg";

import { serverDatabaseUrl, serverDbSchema } from "@/lib/env";

/**
 * Single shared pg Pool for the web server. Uses the Supabase session pooler
 * via DATABASE_URL (service-tier connection, bypasses RLS — the browser never
 * touches this). Cached on globalThis so Next's dev hot-reload doesn't leak
 * pools.
 */
const globalForPg = globalThis as unknown as { __arPgPool?: Pool };

export function pool(): Pool {
  if (!globalForPg.__arPgPool) {
    globalForPg.__arPgPool = new Pool({
      connectionString: serverDatabaseUrl(),
      max: 4
    });
  }
  return globalForPg.__arPgPool;
}

export function quoteIdent(value: string): string {
  if (value.includes("\0")) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/** Runs `fn` with a pooled client whose search_path is set to the app schema. */
export async function withSchema<T>(
  fn: (client: import("pg").PoolClient) => Promise<T>
): Promise<T> {
  const schema = quoteIdent(serverDbSchema());
  const client = await pool().connect();
  try {
    await client.query(`set search_path to ${schema}, public`);
    return await fn(client);
  } finally {
    client.release();
  }
}

export interface OrgProfile {
  orgId: string;
  orgName: string;
  userId: string;
  email: string;
}

/**
 * Resolves the org id for an already-authenticated user. Returns undefined if
 * the profile hasn't been provisioned yet (shouldn't happen post-login since
 * the app layout calls ensureOrgAndProfile, but callers handle it defensively).
 */
export async function getOrgIdForUser(userId: string): Promise<string | undefined> {
  const schema = quoteIdent(serverDbSchema());
  const client = await pool().connect();
  try {
    await client.query(`set search_path to ${schema}, public`);
    const res = await client.query<{ org_id: string }>(
      `select org_id from profiles where user_id = $1`,
      [userId]
    );
    return res.rows[0]?.org_id;
  } finally {
    client.release();
  }
}

/**
 * Idempotently ensures an org + profile exist for an authenticated user.
 * Called as the signup side-effect on first authenticated load.
 *
 * - If the user already has a profile, returns it unchanged.
 * - Otherwise creates a "Personal" org and a profile linking the auth user
 *   to it. The profile primary key is the auth user id, so the insert is
 *   safe under concurrent first loads.
 */
export async function ensureOrgAndProfile(input: {
  userId: string;
  email: string;
}): Promise<OrgProfile> {
  const schema = quoteIdent(serverDbSchema());
  const client = await pool().connect();

  try {
    await client.query(`set search_path to ${schema}, public`);

    // Fast path: profile already exists.
    const existing = await client.query<{
      org_id: string;
      email: string;
      name: string;
    }>(
      `select p.org_id, p.email, o.name
         from profiles p
         join orgs o on o.id = p.org_id
        where p.user_id = $1`,
      [input.userId]
    );

    if (existing.rows[0]) {
      return {
        orgId: existing.rows[0].org_id,
        orgName: existing.rows[0].name,
        userId: input.userId,
        email: existing.rows[0].email
      };
    }

    // Create org + profile in a transaction.
    await client.query("begin");
    try {
      const org = await client.query<{ id: string; name: string }>(
        `insert into orgs (name) values ($1) returning id, name`,
        ["Personal"]
      );
      const orgId = org.rows[0]!.id;

      await client.query(
        `insert into profiles (user_id, org_id, email)
           values ($1, $2, $3)
         on conflict (user_id) do nothing`,
        [input.userId, orgId, input.email]
      );

      await client.query("commit");

      // Re-read in case a concurrent request won the on-conflict race; this
      // returns whichever org the profile actually points at.
      const settled = await client.query<{ org_id: string; name: string }>(
        `select p.org_id, o.name
           from profiles p
           join orgs o on o.id = p.org_id
          where p.user_id = $1`,
        [input.userId]
      );

      return {
        orgId: settled.rows[0]!.org_id,
        orgName: settled.rows[0]!.name,
        userId: input.userId,
        email: input.email
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}
