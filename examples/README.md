# Examples

The examples are split into two groups:

- `quickstart/`: short examples for the first 10 minutes.
- `recipes/`: production-style workflows that exercise lifecycle, artifacts,
  runtime modes, API boundaries, and error handling.

## Setup

Most examples need the API and worker:

```sh
pnpm dev
```

That starts the local API and worker together. To run them separately:

```sh
pnpm api:dev
pnpm worker:dev
```

API-only recipes are marked below and can run with just:

```sh
pnpm api:dev
```

Common environment variables:

```sh
AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
AGENTROUTER_API_KEY=<random-private-token>
AGENTROUTER_MODEL=gpt-4o
AGENTROUTER_CLAUDE_MODEL=claude-sonnet-4-6
AGENTROUTER_TASK="Summarize this repo"
```

## Quickstarts

| Command | What It Covers |
| --- | --- |
| `pnpm example:quickstart:minimal` | Smallest complete TypeScript SDK run |
| `pnpm example:quickstart:run` | `runAgent`, events, final `result.text` |
| `pnpm example:quickstart:stream` | `streamAgent`, `fullStream`, action/execution parts, terminal result |
| `pnpm example:quickstart:claude` | Running the same helper through Claude Code |

Recommended first run:

```sh
pnpm example:quickstart:run
```

## Recipes

| Command | Requires Worker | What It Covers |
| --- | --- | --- |
| `pnpm example:recipe:continue` | Yes | Run-id continuation, sandbox/thread reuse, `getRunTurns`, `closeRun` |
| `pnpm example:recipe:artifacts` | Yes | R2 artifacts, workspace file index, workspace patch, stdout download |
| `pnpm example:recipe:runtime-modes` | Yes | Codex and Claude Code runtime mode selection |
| `pnpm example:recipe:approval-events` | Yes | Manual action approval, policy decisions, and execution event streaming |
| `pnpm example:recipe:low-level` | No | Direct client methods: create, list, events, cancel, get |
| `pnpm example:recipe:errors` | No | `AgentRouterError` handling for API validation failures |
| `pnpm example:recipe:tool-boundary` | No | Current custom-tool boundary and future MCP gateway shape |

Most complete end-to-end demo:

```sh
pnpm example:recipe:artifacts
```

It runs a coding-agent scenario in a Daytona sandbox, streams progress,
restores the final session, downloads R2 artifacts, verifies the workspace file
index, and prints generated files from the workspace patch.

## Event Streaming Recipe

The stream quickstart prints the SDK's high-level `fullStream` parts:

```sh
pnpm example:quickstart:stream
```

Use the approval recipe when you want to see the full control-plane chain:

```sh
pnpm example:recipe:approval-events
```

Event purposes:

| Event or part | Purpose |
| --- | --- |
| `action.proposed` / `part.type === "action"` | AgentRouter has defined the exact runtime action it may execute. |
| `policy.evaluated` / `part.type === "progress"` | The policy decided whether the action is allowed, blocked, or needs approval. |
| `approval.requested` / `part.type === "approval_request"` | Your product can pause here for a human approval workflow. |
| `approval.decided` / `part.type === "approval_decision"` | The immutable approve/deny decision was recorded for the same action digest. |
| `execution.started` / `part.type === "execution"` | The approved action started in the sandbox. |
| `execution.completed` or `execution.failed` / `part.type === "execution"` | The sandbox execution finished; provider failure is represented here, not by rewriting approval history. |

## Runtime Mode Recipe

The runtime-mode recipe defaults to a safe read-only Codex run:

```sh
pnpm example:recipe:runtime-modes
```

Choose a specific runtime case:

```sh
AGENTROUTER_RUNTIME_EXAMPLE=codex-full-access pnpm example:recipe:runtime-modes
AGENTROUTER_RUNTIME_EXAMPLE=claude-plan pnpm example:recipe:runtime-modes
```

Available cases are printed by:

```sh
pnpm example:recipe:runtime-modes -- --help
```

## Compatibility Aliases

The older script names still work:

```sh
pnpm example:sdk
pnpm example:run-agent
pnpm example:stream-agent
pnpm example:claude-code
pnpm example:coding-agent-files
pnpm example:approval-events
pnpm example:tool-boundary
```

## Help

Every example supports `--help`:

```sh
pnpm example:quickstart:run -- --help
pnpm example:recipe:continue -- --help
pnpm example:recipe:errors -- --help
```
