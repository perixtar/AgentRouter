"use server";

import { redirect } from "next/navigation";

import { ensureOrgAndProfile } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export interface AuthActionState {
  error?: string;
  notice?: string;
}

function safeNext(raw: FormDataEntryValue | null): string {
  const next = typeof raw === "string" ? raw : "";
  // Only allow same-origin app paths to avoid open-redirect.
  if (next.startsWith("/") && !next.startsWith("//")) {
    return next;
  }
  return "/playground";
}

export async function loginAction(
  _prev: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error || !data.user) {
    return { error: error?.message ?? "Could not sign in." };
  }

  // Idempotent signup side-effect — also covers users created before the
  // side-effect existed.
  await ensureOrgAndProfile({ userId: data.user.id, email: data.user.email ?? email });

  redirect(next);
}

export async function signupAction(
  _prev: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));

  if (!email || !password) {
    return { error: "Enter your email and password." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) {
    return { error: error.message };
  }

  // When email confirmation is required, Supabase returns a user but no
  // session. In that case there's nothing to gate yet — tell the user to check
  // their inbox. When confirmation is off, we have a live session: provision
  // the org/profile and land on the shell.
  if (data.session && data.user) {
    await ensureOrgAndProfile({
      userId: data.user.id,
      email: data.user.email ?? email
    });
    redirect(next);
  }

  return {
    notice: "Account created. Check your email to confirm, then sign in."
  };
}
