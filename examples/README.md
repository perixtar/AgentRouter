# Examples

Start the local API and worker:

```sh
pnpm dev
```

This keeps the API and worker as separate local processes, but runs both from one command. To run them separately:

```sh
pnpm api:dev
pnpm worker:dev
```

## runAgent

Create a run and print the final agent response:

```sh
pnpm example:run-agent
```

Resume an existing run/session:

```sh
AGENTROUTER_SESSION_ID=run_... AGENTROUTER_AFTER_SEQ=0 pnpm example:run-agent
```

## streamAgent

Create a run and stream safe process updates plus final output through `fullStream`:

```sh
pnpm example:stream-agent
```

## Claude Code

Create a Claude Code run through the same `runAgent` helper:

```sh
pnpm example:claude-code
```

## Coding Agent Files

Run a coding-agent scenario that creates source, test, and docs files in the Daytona sandbox. The example streams progress, restores the final session, downloads R2 artifacts, verifies the workspace file index, and prints every generated file from the workspace patch:

```sh
pnpm example:coding-agent-files
```

## Create Tool

Custom user-defined tools are not passed as raw functions into the sandbox in Phase 1. This example defines a tool contract and demonstrates the current typed rejection. It only needs the API server:

```sh
pnpm example:create-tool
```

## Existing Minimal SDK Example

```sh
pnpm example:sdk
```

To inspect any command without creating a run:

```sh
pnpm example:run-agent -- --help
pnpm example:stream-agent -- --help
pnpm example:claude-code -- --help
pnpm example:coding-agent-files -- --help
pnpm example:create-tool -- --help
```

Optional environment variables:

```sh
AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
AGENTROUTER_API_KEY=<random-private-token>
AGENTROUTER_MODEL=gpt-4o
AGENTROUTER_TASK="Summarize this repo"
```
