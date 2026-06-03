# AgentRouter

Self-hosted runtime for running Codex and Claude Code agents in secure sandboxes.

AgentRouter gives you the backend pieces for production-style coding agents:
an HTTP API, worker loop, sandbox lifecycle, streaming events, persisted run
state, artifacts, and a TypeScript SDK. Bring your own model keys and run
agents from your app, CLI, or CI without rebuilding the orchestration layer.

![Status](https://img.shields.io/badge/status-alpha-orange)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6)
![Node](https://img.shields.io/badge/runtime-Node.js%2024-339933)
![License](https://img.shields.io/badge/license-MIT-green)

> AgentRouter is alpha. The core runtime, SDK, API, worker, and database paths
> are tested, but the setup still expects developers who are comfortable with
> Postgres, sandbox providers, and provider API keys.

## Why AgentRouter

Codex and Claude Code are powerful general-purpose agents, but they are built
primarily as interactive CLIs. Product teams need something different: a way to
turn them into custom agents that run from an app, CLI, dashboard, CI job, or
internal tool.

AgentRouter gives developers the runtime layer for that. You define the product
workflow, such as:

- PR review agents that inspect a diff, run tests, and produce comments.
- Bug reproduction agents that investigate a failing case in a sandbox.
- Test-fixing agents that generate patches and archive changed files.
- Dependency upgrade, release note, and repo documentation agents.
- Internal tools that expose Codex or Claude Code as a controlled API.
- CI workflows that run an agent and collect logs/artifacts.

AgentRouter handles the execution surface around those agents: isolated Daytona
sandboxes, long-running jobs, streaming progress, sessions, permissions,
provider keys, logs, generated files, patches, artifacts, and resume behavior.
The same API and TypeScript SDK can run Codex or Claude Code behind one
interface.

AgentRouter lets you focus on the agent your users need, not the runtime
infrastructure required to operate it.

## Architecture

```mermaid
flowchart LR
  subgraph Client["Developer Surface"]
    App["App / CLI / CI"]
    SDK["TypeScript SDK"]
    Web["Web dashboard"]
  end

  subgraph Control["AgentRouter Control Plane"]
    API["HTTP API"]
    Auth["Auth + API key resolver"]
    Policy["Runtime config + permission policy"]
    Stream["Event stream API"]
  end

  subgraph State["Durable State"]
    PG[("Postgres\nruns, attempts, sessions, turns, events")]
    R2[("R2-compatible storage\nlogs, patches, artifacts, manifests")]
    Keys[("Encrypted provider keys\nBYOK metadata")]
  end

  subgraph Runtime["AgentRouter Runtime Plane"]
    Worker["Worker / job runner"]
    SandboxCtl["Daytona lifecycle\ncreate, resume, suspend, delete"]
    Boundary["Credential boundary\nscoped env + leak checks"]
  end

  subgraph Sandbox["Isolated Sandbox"]
    Workspace["Scratch workspace"]
    Adapter["Runtime adapter"]
    Codex["Codex CLI"]
    Claude["Claude Code"]
  end

  App --> SDK --> API
  Web --> API
  API --> Auth --> PG
  API --> Policy --> PG
  API --> Stream
  Stream --> PG

  PG --> Worker
  Worker --> SandboxCtl --> Workspace
  Worker --> Boundary --> Adapter
  Adapter --> Codex
  Adapter --> Claude

  Codex --> Workspace
  Claude --> Workspace
  Workspace --> Worker
  Worker --> PG
  Worker --> R2
  Keys --> Boundary
  Boundary --> Codex
  Boundary --> Claude

  R2 --> API
  PG --> API
```

The API owns request validation, auth, run creation, idempotency, and streaming.
The worker owns everything after a run is claimed: sandbox lifecycle, runtime
launch, credential scoping, event normalization, artifact capture, and cleanup.
Postgres is the system of record; R2 stores large immutable run artifacts.

This repository contains the self-hosted runtime. Hosted account management,
dashboard, billing, Cloud API keys, and hosted BYOK storage are intentionally
not part of this repository.

## Quickstart

### Prerequisites

- Node.js 24
- pnpm 10
- Postgres
- Daytona API key
- Cloudflare R2-compatible bucket
- `OPENAI_API_KEY` or `CODEX_API_KEY` for Codex
- `ANTHROPIC_API_KEY` for Claude Code

Local unit/integration tests can use placeholder provider and R2 values. Live
sandbox runs require real Daytona, provider, Postgres, and R2 credentials.

### Install

```sh
pnpm install
```

### Configure

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

### Start The Runtime

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

### Create A Run

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

If you are not running the worker loop, process one queued run manually:

```sh
pnpm worker:run-once
```

## TypeScript SDK

Install the SDK from npm:

```sh
npm install @agentrouterhq/sdk
```

```ts
import { agentrouter, codex, runAgent } from "@agentrouterhq/sdk";

const client = agentrouter({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.AGENTROUTER_API_KEY!
});

const result = await runAgent({
  client,
  task: "Inspect this repo and summarize the test strategy.",
  runtime: codex({ mode: "default", model: "gpt-4o" })
});

console.log(result.text);
```

Run the SDK example:

```sh
pnpm example:quickstart:run
```

## Multi-Turn Runs

A run id can become the conversation handle. Start a run, then continue it by
posting a follow-up message to the same run id.

```ts
import { agentrouter, codex, streamAgent } from "@agentrouterhq/sdk";

const client = agentrouter({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.AGENTROUTER_API_KEY!
});

const turn1 = await streamAgent({
  client,
  task: "Create src/fib.ts with a fib(n) function.",
  runtime: codex({ mode: "full_access" })
});

// After the first run completes within the continuation grace window:
const firstResult = await turn1.finalResult;
const turn2 = await streamAgent({
  client,
  continueRun: firstResult.id,
  message: "Now add tests for fib(n)."
});

for await (const part of turn2.fullStream) {
  if (part.type === "progress") console.log(part.text);
  if (part.type === "text") process.stdout.write(part.text);
}
```

See [packages/sdk-typescript/README.md](packages/sdk-typescript/README.md) for
the full SDK surface.

## Examples

Quickstarts:

```sh
pnpm example:quickstart:minimal
pnpm example:quickstart:run
pnpm example:quickstart:stream
pnpm example:quickstart:claude
```

Recipes:

```sh
pnpm example:recipe:continue
pnpm example:recipe:artifacts
pnpm example:recipe:runtime-modes
pnpm example:recipe:low-level
pnpm example:recipe:errors
pnpm example:recipe:tool-boundary
```

The most complete end-to-end demo is:

```sh
pnpm example:recipe:artifacts
```

It runs a coding-agent scenario in a Daytona sandbox, streams progress,
restores the final session, downloads R2 artifacts, verifies the workspace file
index, and prints generated files from the workspace patch.

## Documentation

- [Self-hosting guide](docs/self-hosting.md)
- [Examples guide](examples/README.md)
- [TypeScript SDK guide](packages/sdk-typescript/README.md)
- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)

## Security Model

AgentRouter is designed around a narrow trust boundary:

- Provider keys are read by the worker and passed only to the provider process.
- Provider keys are not copied into the general sandbox environment.
- Agent commands run inside sandboxed Daytona environments.
- API access is protected by a self-hosted bearer token: `AGENTROUTER_API_KEY`.
- Run events and artifacts are persisted for inspection and replay.
- Credential-boundary tests check that canary secrets do not leak into logs,
  events, or archived artifacts.

This repository does not store hosted customer provider keys. Self-hosted users
keep provider credentials in their own environment.

## Packages

| Package | Purpose |
| --- | --- |
| `@agentrouterhq/sdk` | TypeScript client and helpers for creating, streaming, and continuing runs |
| `@agentrouter/api` | Fastify API server for runs, events, artifacts, and sessions |
| `@agentrouter/worker` | Worker loop that claims runs and executes them in sandboxes |
| `@agentrouter/core` | Shared run state, event normalization, and provider output parsing |
| `@agentrouter/db` | Postgres schema and repository helpers |
| `@agentrouter/runtime-codex-cli` | Codex CLI runtime adapter |
| `@agentrouter/runtime-claude-code` | Claude Code runtime adapter |
| `@agentrouter/sandbox-daytona` | Daytona sandbox driver |
| `@agentrouter/artifacts-r2` | R2 artifact storage |
| `@agentrouter/openapi` | OpenAPI contract |

## Development

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

Run the self-hosted runtime as two processes:

```sh
pnpm api:start
pnpm worker:start
```

The included [Dockerfile](Dockerfile) builds the runtime image. It starts the
API process by default; run a separate worker process for queued runs.

## Project Status

Current focus:

- Reduce first-run setup friction.
- Add stronger SDK examples for installed-package usage.
- Add a polished PR-review demo.
- Add approval-gate docs and examples.

## Community

AgentRouter is early. Issues about setup friction, runtime bugs, and example
requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the local
development workflow.

## License

AgentRouter is released under the [MIT License](LICENSE).
