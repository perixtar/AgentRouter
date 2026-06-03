# AgentRouter

Open-source runtime for running Claude Code and Codex agents in sandboxes.

AgentRouter gives you the backend pieces for coding agents: an API, worker,
sandbox lifecycle, streaming events, persisted run state, artifacts, and a
TypeScript SDK. Bring your own OpenAI or Anthropic key and run agents from your
app, CLI, or CI without rebuilding the runtime loop.

> Status: alpha. The runtime works, but the first-launch developer experience is
> still being tightened. Expect rough edges around setup and external service
> credentials.

## What You Can Build

- PR review agents that clone a repo, inspect a diff, run tests, and produce comments.
- Bug reproduction agents that run a failing scenario in an isolated sandbox.
- Test-fixing agents that generate patches and archive workspace artifacts.
- Release, dependency-upgrade, and repo-documentation agents.
- Internal tools that call Claude Code or Codex through one runtime API.

## How It Works

```txt
Your app / CI / CLI
  -> AgentRouter API
  -> Postgres run state
  -> Worker
  -> Daytona sandbox
  -> Codex CLI or Claude Code
  -> R2 logs and artifacts
```

AgentRouter does not include model usage. You use your own provider keys:

- `OPENAI_API_KEY` or `CODEX_API_KEY` for Codex.
- `ANTHROPIC_API_KEY` for Claude Code.

## Quickstart

### 1. Install

```sh
pnpm install
```

### 2. Configure Environment

Copy the example environment file:

```sh
cp .env.example .env
```

Fill in the required values:

```sh
AGENTROUTER_API_KEY=ar_local_dev_secret
DATABASE_URL=postgres://...
DAYTONA_API_KEY=...
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=...
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

For local-only tests, you can use placeholder provider and R2 values. Live
sandbox runs require real Daytona and provider credentials.

### 3. Run The API And Worker

```sh
pnpm dev
```

This starts:

- API server on `http://127.0.0.1:8787`
- Worker process that claims queued runs and starts sandboxes

Run them separately when debugging:

```sh
pnpm api:dev
pnpm worker:dev
```

### 4. Create A Codex Run

```sh
curl -sS http://127.0.0.1:8787/v1/runs \
  -H "Authorization: Bearer $AGENTROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Reply exactly AR_CODEX_OK",
    "runtime": {
      "kind": "codex",
      "mode": "default",
      "model": "gpt-4o"
    }
  }'
```

Process one queued run:

```sh
pnpm worker:run-once
```

## TypeScript SDK

Use the workspace SDK while developing locally:

```ts
import { agentrouter, codex, runAgent } from "@agentrouter/sdk";

const client = agentrouter({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.AGENTROUTER_API_KEY!
});

const result = await runAgent({
  client,
  task: "Reply exactly AR_CODEX_OK",
  runtime: codex({ mode: "default", model: "gpt-4o" })
});

console.log(result.text);
```

Run the example:

```sh
pnpm example:run-agent
```

## Examples

```sh
pnpm example:run-agent
pnpm example:stream-agent
pnpm example:claude-code
pnpm example:coding-agent-files
pnpm example:tool-boundary
```

The most complete demo today is:

```sh
pnpm example:coding-agent-files
```

It runs a coding-agent scenario in a Daytona sandbox, streams progress, restores
the final session, downloads R2 artifacts, verifies the workspace file index,
and prints generated files from the workspace patch.

## Packages

| Package | Purpose |
| --- | --- |
| `@agentrouter/sdk` | TypeScript client and helpers for creating and streaming runs |
| `@agentrouter/core` | Shared run state, event normalization, and provider output parsing |
| `@agentrouter/api` | Fastify API server for run creation, sessions, files, and events |
| `@agentrouter/worker` | Worker loop that claims runs and executes them in sandboxes |
| `@agentrouter/runtime-codex-cli` | Codex CLI runtime adapter |
| `@agentrouter/runtime-claude-code` | Claude Code runtime adapter |
| `@agentrouter/sandbox-daytona` | Daytona sandbox driver |
| `@agentrouter/db` | Postgres schema and repository helpers |
| `@agentrouter/artifacts-r2` | R2 artifact storage |
| `@agentrouter/openapi` | OpenAPI contract |

## Test Commands

Local checks:

```sh
pnpm typecheck
pnpm test:ci
```

Focused test suites:

```sh
pnpm test:unit
pnpm test:api
pnpm test:sdk
pnpm test:db
pnpm test:worker
```

External service tests:

```sh
pnpm test:r2
pnpm test:daytona
pnpm test:providers:smoke
pnpm test:e2e:codex
pnpm test:e2e:claude
```

External tests require real credentials and may create cloud resources.

## Deployment

The open-source runtime can be self-hosted as two processes:

```sh
pnpm api:start
pnpm worker:start
```

The included `Dockerfile` builds the runtime image. This repo contains the
self-hosted runtime; hosted AgentRouter Cloud is not required to use it.

## Roadmap Before A Larger Launch

- Simplify the first local demo so a developer can see value with fewer services.
- Publish the TypeScript SDK to npm.
- Add a polished PR-review demo.
- Add clearer docs for provider keys, Daytona, Postgres, and R2 setup.
- Add approval-gate docs and examples.

## Community

AgentRouter is early. Issues and PRs are welcome once the public repo is ready.

## License

Add a license before the first public launch.
