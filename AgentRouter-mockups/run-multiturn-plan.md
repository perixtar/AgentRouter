# Plan: make /v1/runs multi-turn, keyed off the run id

**Status:** proposed (plan only) · **Date:** 2026-06-02 · grounded in the post-`271378e` tree

## Key insight
The multi-turn machinery **already exists** end-to-end (sessions/turns, persistent sandbox, Codex resume) — it's just keyed off a separate `sess_…` id and a parallel `/v1/sessions` surface. The ask is mostly **re-keying to the run id + unifying the surface**, not new runtime work.

## Recommended design
- `POST /v1/runs` stays **byte-identical** (returns `runId`). Continue with **`POST /v1/runs/:id/messages`** (turn 2+). The **run id is the conversation handle**. Add `GET /v1/runs/:id/turns` + `POST /v1/runs/:id/close`; `runToApi` gains nullable `sessionId`/`conversationId` (additive).
- **Lazy promotion:** a plain run creates **no** session (stays a cheap, ephemeral, self-deleting one-shot — no regression). On the **first continuation**, it promotes to a session (reuses the already-hardened atomic turn+run logic from `/v1/sessions/:id/messages`).
- **Fold `/v1/sessions` internal:** keep sessions/turns as implementation tables; stop minting user-facing `sess_…` ids; deprecate `/v1/sessions*` for one release (web/SDK keep working during cutover), then remove. No data migration (additive columns only).
- **SDK:** add real `continueRun(runId, message)` / `getRunTurns` / multi-turn stream helper; **fix the bogus `runAgent({sessionId})` resume** (it routes a sessionId into a runId param and only *waits*, never continues — delete the `sessionId` field, make resume actually send the message); add `x-ar-org-id` header support so the **web can finally use the real SDK**.
- **Web:** repoint Playground "send message" from session-id to run-id; then (last step) switch `apps/web/lib/agentrouter.ts` to `@agentrouter/sdk`.

## The cost fix (the 30 GiB issue)
A sandbox is persistent **only once a run is continued**. Add an **app-side idle reaper**: set `sessions.idle_deadline_at` on each suspend; a worker sweep deletes the sandbox after idle TTL (default **30m**) and closes the session. Lower Daytona `autoDelete` backstop to **~90m** (from 24h) and wire the (currently-unwired) TTL envs. `/v1/runs/:id/close` reclaims immediately.

## The one real catch (decision #1)
A plain one-shot run's sandbox is **deleted** when it finishes, and its Codex thread was `--ephemeral`. So continuing it **can't truly resume turn-1's files/context** — unless we add **"continuable-one-shot grace"**: keep the sandbox **suspended ~10 min** instead of deleting, so a fast follow-up genuinely resumes (fs + Codex thread intact). The reaper deletes it if no follow-up arrives. *Rec: on, 10m grace.* (Alternative: lossy "continue = fresh sandbox + replayed context.")

## Open decisions (rec in italics)
1. First-turn resume fidelity: **continuable-one-shot grace-suspend (10m)** vs lossy replay. *Rec: grace, 10m.*
2. TTLs: idle reaper **30m**, Daytona autoDelete backstop **90m**, env-tunable. *Rec: ship.*
3. `/v1/sessions`: deprecate now, remove after web+SDK cut over. *Rec: deprecate-then-remove.*
4. `runAgent` resume: delete the never-worked `sessionId` field, add real `continueRun`-based resume. *Rec: yes.*
5. Web→real-SDK switch: do it in the last milestone, gated on SDK `x-ar-org-id` support. *Rec: yes, M3.*
6. Conversation handle = the first run's id (`conversationId`); later turns keep own run ids but resolve to the same conversation. *Rec: yes.*

## Layered change table
| Layer | Change |
|---|---|
| **API** | `POST /v1/runs/:id/messages`, `GET /v1/runs/:id/turns`, `POST /v1/runs/:id/close`; resolve run→session + lazy promote; expose `sessionId`/`conversationId`; deprecate `/v1/sessions*` |
| **db** | `sessions.origin_run_id`, `sessions.idle_deadline_at` (+index); `promoteRunToSession` (txn), `claimReapableSessions` |
| **worker** | idle-reaper sweep in `runWorkerLoop`; set `idle_deadline_at` on suspend; wire TTL envs; (opt) stream session path; (opt) one-shot grace-suspend |
| **sandbox** | lower default `autoDeleteInterval` |
| **SDK** | `continueRun`/`getRunTurns`/stream helper; fix `runAgent` resume; `x-ar-org-id` header support |
| **web** | Playground send-by-runId; drop/forward `/api/playground/session/*`; switch to `@agentrouter/sdk` |

## Milestones (each QA-verified as a real actor)
- **M1 — Run-id continuation + lazy promotion** (API+db+worker). QA: plain `/v1/runs` still deletes its sandbox (no regression); `/messages` → turn 2 edits the persisted fs + resumes context; DB shows 1 session/`origin_run_id`/2 turns/2 runs/stable sandbox running→suspended; concurrency 409.
- **M2 — Cost reaper + SDK.** QA: idle past TTL → sandbox reclaimed; `/close` → immediate delete; SDK `continueRun` round-trips a 2-turn convo; `runAgent` resume actually sends the message; tests green.
- **M3 — Web on run-id + real SDK; deprecate `/v1/sessions`.** QA: browser 2-turn Playground (turn 2 edits existing file, cumulative Files); `/v1/sessions*` still answers but web no longer calls it; build+typecheck green.

## Backward-compat
`POST /v1/runs` request+response unchanged (response only *gains* nullable fields). One-shot lifecycle identical (the headline no-regression gate). `/v1/sessions*` stays one release. No destructive migration.
