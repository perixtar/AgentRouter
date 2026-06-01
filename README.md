# AgentRouter

Phase 1 runtime control plane for launching coding agents in Daytona sandboxes, storing run state in Postgres, and archiving logs/session artifacts in Cloudflare R2.

Design docs live in `docs/`, including `docs/phase1-runtime-plan.html`.

## Phase 1 Quickstart

1. Fill `.env` from `.env.example` with real Daytona, OpenAI/Codex, Postgres, and R2 credentials.
2. Install dependencies:

```sh
pnpm install
```

3. Start the local control plane and worker:

```sh
pnpm dev
```

This starts the API and worker as separate local processes. The API accepts run requests; the worker claims queued runs, creates Daytona sandboxes, and launches Codex inside them.

If you need to run them separately:

```sh
pnpm api:dev
pnpm worker:dev
```

4. Create a run through the API:

```sh
curl -sS http://127.0.0.1:8787/v1/runs \
  -H "Authorization: Bearer $AGENTROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Reply exactly AR_CODEX_OK",
    "runtime": { "kind": "codex", "mode": "default", "model": "gpt-4o" }
  }'
```

Use `pnpm worker:run-once` to process a single queued run, or `pnpm test:e2e:codex` to run the live SDK -> API -> worker -> Daytona -> Codex -> R2 smoke test. The live file-creation smoke uses `runtime.mode = "full_access"` because Daytona is the outer sandbox; Codex `workspace-write` can hit nested sandbox restrictions in the default Daytona image.

## Test Commands

```sh
pnpm test
pnpm test:db
pnpm test:r2
pnpm test:daytona
pnpm test:providers:smoke
pnpm test:e2e:codex
pnpm typecheck
```
