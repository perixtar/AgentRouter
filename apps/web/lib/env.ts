/**
 * Centralized env access. Public values are inlined by Next at build time;
 * server-only values are read lazily so importing this in a client bundle
 * never trips on a missing secret.
 */

export const SUPABASE_URL = required(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  "NEXT_PUBLIC_SUPABASE_URL"
);

export const SUPABASE_ANON_KEY = required(
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  "NEXT_PUBLIC_SUPABASE_ANON_KEY"
);

export function serverDatabaseUrl(): string {
  return required(process.env.DATABASE_URL, "DATABASE_URL");
}

export function serverDbSchema(): string {
  return process.env.AGENTROUTER_DB_SCHEMA ?? "public";
}

export function agentRouterApiUrl(): string {
  return process.env.AGENTROUTER_API_URL ?? "http://127.0.0.1:8787";
}

export function webServiceToken(): string {
  return required(
    process.env.AGENTROUTER_WEB_SERVICE_TOKEN,
    "AGENTROUTER_WEB_SERVICE_TOKEN"
  );
}

function required(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
