# AgentRouter

Phase 1 runtime control plane for launching coding agents in Daytona sandboxes, storing run state in Postgres, and archiving logs/session artifacts in Cloudflare R2.

Design docs live in `docs/`, including `docs/phase1-runtime-plan.html`.

## Phase 1 Quickstart

1. Fill `.env` from `.env.example` with real Daytona, OpenAI/Codex, Anthropic/Claude Code, Postgres, and R2 credentials. Set `AGENTROUTER_API_KEY` to a private random bearer token; the API refuses the old example default.
2. Install dependencies:

```sh
pnpm install
```

3. Start the local control plane and worker:

```sh
pnpm dev
```

This starts the API and worker as separate local processes. The API accepts run requests; the worker claims queued runs, creates Daytona sandboxes, and launches Codex or Claude Code inside them.

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

For the TypeScript SDK happy path, use `runAgent()` and read `result.text`:

```ts
const result = await runAgent({ client, task: "Reply exactly AR_CODEX_OK" });
console.log(result.text);
```

Claude Code uses the same run contract:

```sh
pnpm example:claude-code
pnpm test:e2e:claude
```

`pnpm test:e2e:claude` requires a funded `ANTHROPIC_API_KEY`; otherwise the run reaches Claude Code in Daytona and fails with Anthropic's billing error.

## Test Commands

```sh
pnpm test
pnpm test:ci
pnpm test:external
pnpm test:db
pnpm test:r2
pnpm test:daytona
pnpm test:providers:smoke
pnpm test:claude
pnpm test:e2e:codex
pnpm test:e2e:claude
pnpm typecheck
```

## GitHub Actions Tests

`.github/workflows/test.yml` runs typecheck and local DB-backed tests on pull requests
and pushes to `main`. Pushes to `main` and manual runs also run real R2, Daytona,
Codex, and Claude Code E2E tests.

GitHub Actions E2E uses repository secrets:

```sh
DAYTONA_API_KEY
OPENAI_API_KEY
ANTHROPIC_API_KEY
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_ENDPOINT
```

The CI jobs create their own Postgres service and use a per-job R2 artifact prefix.
Claude Code E2E is wired but gated by the `RUN_CLAUDE_E2E=1` repository variable
or the manual workflow checkbox because it requires a funded Anthropic account.

## Fly.io Deployment

The repo includes `fly.toml`, `Dockerfile`, and `.github/workflows/fly.yml`.
The workflow deploys after the `Tests` workflow succeeds on `main` and can also be
run manually from GitHub Actions.

GitHub Actions uses:

```sh
FLY_API_TOKEN # repository secret
FLY_APP_NAME  # repository variable, defaults to agentrouter-dev
```

Before the first deploy, set the runtime secrets on the Fly app:

```sh
flyctl secrets set \
  AGENTROUTER_API_KEY=... \
  DATABASE_URL=... \
  DAYTONA_API_KEY=... \
  OPENAI_API_KEY=... \
  ANTHROPIC_API_KEY=... \
  R2_ACCOUNT_ID=... \
  R2_ACCESS_KEY_ID=... \
  R2_SECRET_ACCESS_KEY=... \
  R2_BUCKET=... \
  R2_ENDPOINT=... \
  --app agentrouter-dev
```
