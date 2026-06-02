# AgentRouter — Web + Multi-Tenant + Multi-Turn: Build Plan (approved contract)

**Date:** 2026-06-01 · **Stack:** Supabase (DB+Auth, one project local&prod) · Next.js/Vercel · Fastify API + worker on Fly.io · Daytona · R2

## Locked architecture decisions
1. **Tenant isolation = app-layer `org_id` filtering** at the repository chokepoint (service-role connection), enforced by a mandatory `orgId` param on every `RunRepository` read/write + a cross-tenant QA test. *Not* Postgres RLS, *not* schema-per-tenant. (RLS not load-bearing because the browser never reads runtime data directly — all via the Fly API.)
2. **Web→API auth = shared web service token + asserted org** (refined 2026-06-01 to avoid storing per-org key plaintext / keeping the master key off Vercel). The Next.js *server* holds one `AGENTROUTER_WEB_SERVICE_TOKEN` (Fly API + Vercel env); after verifying the Supabase session and resolving the user's `org_id`, it calls the Fly API with `Authorization: Bearer <service-token>` + header `X-AR-Org-Id: <org>`. Fastify `authenticate()`: if the bearer is the web service token → trust `X-AR-Org-Id`; ELSE hash the bearer → `api_keys` row → `org_id` (this second path is for **external SDK customers** using their `ar_live_…` keys). Browser never holds an AgentRouter secret; only the Supabase auth cookie. External behavior unchanged (customers still use `ar_live_…`).
3. **Migrations stay in the in-code migrator** (`applyPhase1Migrations`, idempotent `create table if not exists`) — it's the parity mechanism (runs identically on Fly boot & local boot). One-time SQL file only for Auth/RLS bits the app doesn't own.
4. **BYOK encryption: AES-256-GCM, master key on Fly ONLY.** New `packages/security/secret-box`. `AGENTROUTER_MASTER_KEY` (32-byte base64) lives on Fly (API+worker) — NOT on Vercel. The web server proxies BYOK save through the Fly API so plaintext + master key stay in one trust tier.
5. **Supabase is the source of truth** (the earlier `playground-plan.md` Neon mention is stale).
6. **Pin `@openai/codex`** to a known resume-capable version in `ensureCodex` (currently unpinned) before M4.

## Schema (added to the in-code migrator; all `create table if not exists`)
- `orgs` (one per signup), `profiles` (1:1 with `auth.users`, → org), `api_keys` (hashed secret + prefix + scopes + revoke + org_id), `provider_keys` (BYOK OpenAI: `key_ciphertext/iv/tag` bytea + `key_last4` + `master_key_version`, unique per org+provider), `sessions` (owns a persistent `sandbox_id` + `sandbox_state` + `codex_session_id`), `turns` (each user message → one `run_id`).
- Existing runs tables get `org_id` (nullable, additive): `alter table runs/run_attempts add column if not exists org_id`. Repo methods gain a mandatory `orgId` filter.

## Auth flow (Playground "Run")
Browser (Supabase cookie) → `POST /api/playground/run` (Next.js server) → `getUser()`→`org_id`→ load org `web:runtime` key → `agentrouter({apiKey}).createRun()` → Fly API `authenticate()`→`orgId`→`run.org_id`. Signup side-effect (server action, idempotent): upsert org + profile + mint internal web key.

## BYOK per run (worker)
On claim, run has `org_id` → decrypt that org's `provider_keys` row (service-side) → `buildProviderProcessEnv({rawProviderKey: orgKey})` → flows through the **existing** credential boundary into the single `codex exec` env only (never `generalSandboxEnv`, never create-time env; scanned+redacted as canary). No org key → fail `byok_missing` → UI "Connect your OpenAI key."

## Multi-turn (M4)
Make sandboxes persistent (`ephemeral:false`, `autoStopInterval:15m`, `autoArchive:60m`, `autoDelete:1440m`, env-tunable). Driver `suspend/resume/setIdleTtl`. Turn flow: lazy sandbox create on turn 1 (one git init), resume on later turns, run codex with **resume** of the stored `codex_session_id`, then **suspend (not delete)**. New API: `POST /v1/sessions`, `POST /v1/sessions/:id/messages`, `GET /v1/sessions/:id[/events|stream]`, `POST /v1/sessions/:id/close`. SDK: `createSession/sendMessage/streamSession`.
**Risks to spike before M4:** exact Codex resume subcommand + session-id JSON field (version-dependent); Daytona suspend/resume cost+latency; per-session concurrency lock.

## apps/web (Next.js App Router, Vercel)
`middleware.ts` (@supabase/ssr session + gating), `(auth)/login|signup`, `(app)/layout` (sidebar shell), `(app)/playground`, `(app)/keys`, `app/api/*` route handlers (server-side key resolution — keeps secrets off the client), `components/primitives` (port OKLCH tokens + `.btn/.badge/.win/.term/...` from `playground.html`), `lib/supabase|agentrouter|env`. Geist via `next/font`.

## Milestones (each independently shippable & QA-verified as a real actor)
- **M1 — Web shell + Supabase Auth:** scaffold, tokens/primitives, signup/login, middleware gating, signup side-effect; orgs/profiles/api_keys tables. *QA:* sign up in a browser → land on shell → DB has user+org+profile+web key → logout re-gates.
- **M2 — Live one-shot Playground:** wire to existing `/v1/runs` via SDK through server routes; stream terminal + Files; `org_id` on runs + `authenticate()`→org. *QA:* run a real task, watch real stdout, Files shows created file; second org can't read first's run; bad bearer → 401.
- **M3 — API Keys + BYOK:** create→reveal-once/revoke `ar_live_…`; paste `sk-…` encrypted at rest; worker runs on the org's key. *QA:* run hits the user's OpenAI account; delete BYOK → `byok_missing`; revoke key → 401; ciphertext unreadable in DB.
- **M4 — Multi-turn:** persistent sandbox + Codex resume; sessions/turns + `/v1/sessions*`; multi-message chat. *QA:* "write fib.py" then "add a test" in same chat edits the existing file (fs persisted) + resumes context; sandbox suspends between turns, resumes on follow-up.
