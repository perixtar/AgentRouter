"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { BrandMark } from "@/components/brand-mark";
import type { AuthActionState } from "./actions";

type Action = (
  state: AuthActionState,
  formData: FormData
) => Promise<AuthActionState>;

interface AuthFormProps {
  mode: "login" | "signup";
  action: Action;
  next: string;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="btn primary"
      disabled={pending}
      style={{ width: "100%", height: 40, marginTop: 4 }}
    >
      {pending ? "Working…" : label}
    </button>
  );
}

export function AuthForm({ mode, action, next }: AuthFormProps) {
  const [state, formAction] = useActionState<AuthActionState, FormData>(action, {});
  const isSignup = mode === "signup";

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <div style={{ lineHeight: 1.1 }}>
            <div className="brand-name">AgentRouter</div>
            <div className="brand-sub">control plane</div>
          </div>
        </div>

        <h1 className="auth-title">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="auth-sub">
          {isSignup
            ? "Spin up an org and run coding agents on your own key."
            : "Sign in to your AgentRouter control plane."}
        </p>

        {state.error ? (
          <div className="auth-error" role="alert">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span>{state.error}</span>
          </div>
        ) : null}

        {state.notice ? (
          <div className="auth-note" role="status">
            <span className="dot ok" style={{ marginTop: 5 }} />
            <span>{state.notice}</span>
          </div>
        ) : null}

        <form action={formAction}>
          <input type="hidden" name="next" value={next} />

          <div className="auth-field-group">
            <label className="auth-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className="field mono"
              placeholder="you@company.com"
            />
          </div>

          <div className="auth-field-group">
            <label className="auth-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={isSignup ? "new-password" : "current-password"}
              required
              minLength={isSignup ? 8 : undefined}
              className="field mono"
              placeholder={isSignup ? "At least 8 characters" : "••••••••"}
            />
          </div>

          <SubmitButton label={isSignup ? "Create account" : "Sign in"} />
        </form>

        <div className="auth-foot">
          {isSignup ? (
            <>
              Already have an account? <Link href="/login">Sign in</Link>
            </>
          ) : (
            <>
              New to AgentRouter? <Link href="/signup">Create an account</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
