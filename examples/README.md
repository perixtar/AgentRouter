# Examples

Start the API:

```sh
pnpm api:dev
```

Start the worker in another terminal for examples that run an agent:

```sh
pnpm worker:dev
```

## runAgent

Create a run and wait for the restored session:

```sh
pnpm example:run-agent
```

Resume an existing run/session:

```sh
AGENTROUTER_SESSION_ID=run_... AGENTROUTER_AFTER_SEQ=0 pnpm example:run-agent
```

## streamAgent

Create a run and stream normalized events until terminal:

```sh
pnpm example:stream-agent
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
pnpm example:create-tool -- --help
```

Optional environment variables:

```sh
AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
AGENTROUTER_API_KEY=ar_dev_local_change_me
AGENTROUTER_MODEL=gpt-4o
AGENTROUTER_TASK="Summarize this repo"
```
