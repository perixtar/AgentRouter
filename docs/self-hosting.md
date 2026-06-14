# Self-Hosting AgentRouter

This guide covers the current self-hosted runtime shape: one API process, one
worker process, Postgres for run state, Daytona for sandboxes, and
R2-compatible object storage for logs and artifacts.

## Services

AgentRouter needs:

- Postgres 16 or newer.
- A Daytona API key.
- A Cloudflare R2-compatible bucket.
- `OPENAI_API_KEY` or `CODEX_API_KEY` for Codex runs.
- `ANTHROPIC_API_KEY` for Claude Code runs.

The API and worker can run on the same machine during development. For a real
deployment, run them as separate long-lived processes against the same
`DATABASE_URL` and `AGENTROUTER_DB_SCHEMA`.

## Environment

Start from the example file:

```sh
cp .env.example .env
```

Required runtime values:

```sh
# Private bearer token for your self-hosted AgentRouter API.
# This is not an OpenAI/Anthropic provider key; choose any random value.
AGENTROUTER_API_KEY=ar_local_dev_secret
DATABASE_URL=postgres://user:pass@host:5432/agentrouter
DAYTONA_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_REGION=auto
R2_ARTIFACT_PREFIX=dev/runs/
```

`CODEX_API_KEY` wins over `OPENAI_API_KEY` when both are set.

## Run Locally

```sh
pnpm install
pnpm dev
```

This starts both processes:

- API: `http://127.0.0.1:8787`
- Worker: polls Postgres for queued runs

Run them separately when debugging:

```sh
pnpm api:dev
pnpm worker:dev
```

## Run In Production

Run the API:

```sh
pnpm api:start
```

Run the worker:

```sh
pnpm worker:start
```

The included `Dockerfile` starts the API by default. Run a second container or
process for the worker command.

## Sandbox Lifecycle

The worker creates Daytona sandboxes for runs. One-shot runs are deleted when
finished unless they are eligible for a short continuation grace window.
Continued Codex conversations use a persistent sandbox and are reclaimed by the
worker reaper after the idle deadline.

The public API is run-id based:

- `POST /v1/runs` creates the first run.
- `POST /v1/runs/:runId/messages` continues a conversation.
- `GET /v1/runs/:runId/turns` lists conversation turns.
- `POST /v1/runs/:runId/close` closes the conversation and arms sandbox
  reclaim.

There is no separate public session API in the pre-launch surface. Internal
session rows are only an implementation detail for preserving the sandbox and
provider thread between run-id turns.

For continued conversations, `conversationId` and `runId` have different jobs:

```txt
conversationId  stable id for the whole conversation; this is the first run id
runId           id for one specific turn; each continued turn gets a new run id
```

The `:runId` path parameter on `/messages`, `/turns`, and `/close` is the
conversation id. A successful `/messages` call returns the new turn's `runId`
plus the stable `conversationId`.

Useful lifecycle env vars:

```sh
AGENTROUTER_ONESHOT_GRACE_MINUTES=10
AGENTROUTER_SESSION_IDLE_TTL_MINUTES=30
AGENTROUTER_SESSION_AUTOSTOP_MINUTES=15
AGENTROUTER_SESSION_AUTODELETE_MINUTES=90
AGENTROUTER_REAPER_INTERVAL_SECONDS=60
```

## Health Checks

The API exposes:

```sh
curl http://127.0.0.1:8787/healthz
```

Run local verification:

```sh
pnpm typecheck
pnpm test:ci
pnpm test:worker
```

External tests require real Daytona, provider, and R2 credentials:

```sh
pnpm test:external
pnpm test:e2e:codex
pnpm test:e2e:claude
```
