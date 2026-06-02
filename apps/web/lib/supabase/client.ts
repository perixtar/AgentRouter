"use client";

import { createBrowserClient } from "@supabase/ssr";

import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

/**
 * Browser-side Supabase client. Holds only the public anon key and the
 * auth cookie — never an AgentRouter secret.
 */
export function createClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
