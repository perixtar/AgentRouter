# AgentRouter TypeScript SDK

[![npm version](https://img.shields.io/npm/v/@agentrouterhq/sdk.svg)](https://www.npmjs.com/package/@agentrouterhq/sdk)
[![license](https://img.shields.io/npm/l/@agentrouterhq/sdk.svg)](https://github.com/perixtar/AgentRouter/blob/main/LICENSE)
[![types](https://img.shields.io/badge/types-TypeScript-3178c6)](https://github.com/perixtar/AgentRouter)

The TypeScript client for AgentRouter, a self-hosted runtime for running Codex
and Claude Code agents in secure sandboxes.

Use the SDK to create agent runs, stream observable progress, continue a
conversation by run id, fetch artifacts, and control long-running coding-agent
workflows from your app, CLI, or CI.

## Installation

```sh
npm install @agentrouterhq/sdk
```

```sh
pnpm add @agentrouterhq/sdk
```

```sh
yarn add @agentrouterhq/sdk
```

## Requirements

- A running AgentRouter API, usually `http://127.0.0.1:8787` for local
  self-hosting.
- An `AGENTROUTER_API_KEY` bearer token configured on the AgentRouter API.
- Provider credentials on the runtime side, such as `OPENAI_API_KEY`,
  `CODEX_API_KEY`, or `ANTHROPIC_API_KEY`.
- A server-side TypeScript or JavaScript runtime with `fetch`.

This SDK does not call OpenAI, Anthropic, Daytona, or R2 directly. It talks to
your AgentRouter API, and the runtime keeps provider keys server-side.

## Quickstart

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

console.log(result.status);
console.log(result.text);
```

`runAgent` creates a run, waits until it reaches a terminal state, and returns
the final session snapshot:

```ts
result.id;               // run id
result.status;           // completed | failed | cancelled
result.text;             // final agent response text, when available
result.artifacts.items;  // generated logs, patches, and workspace artifacts
result.eventCursor;      // last observed event sequence
```

## Streaming a run

Use `streamAgent` when you want progress updates while the sandboxed agent is
working.

```ts
import { agentrouter, codex, streamAgent } from "@agentrouterhq/sdk";

const client = agentrouter({
  baseUrl: process.env.AGENTROUTER_API_BASE_URL ?? "http://127.0.0.1:8787",
  apiKey: process.env.AGENTROUTER_API_KEY!
});

const stream = await streamAgent({
  client,
  task: "Create reports/agent-smoke.txt and explain what you changed.",
  runtime: codex({ mode: "full_access" }),
  pollIntervalMs: 1000,
  maxWaitMs: 10 * 60 * 1000
});

for await (const part of stream.fullStream) {
  if (part.type === "progress") console.log("process:", part.text);
  if (part.type === "message") console.log("agent:", part.text);
  if (part.type === "text") process.stdout.write(part.text);
  if (part.type === "error") console.error(part.text);
}

const final = await stream.finalResult;
console.log(final.status);
```

`fullStream` emits safe progress summaries, messages, final text, errors, and
terminal status. It does not expose hidden model chain-of-thought.

If you only want final text chunks:

```ts
for await (const text of stream.textStream) {
  process.stdout.write(text);
}
```

## Continue a conversation

AgentRouter can keep a sandbox and provider thread alive after a run finishes.
The first run id becomes the conversation handle.

Run ids are the SDK's public conversation handle. Use `streamAgent` with
`continueRun` for streamed follow-up turns, or `runAgent` with `continueRun`
when you only need the final result. There is no separate public session API.

```ts
import { agentrouter, codex, runAgent, streamAgent } from "@agentrouterhq/sdk";

const client = agentrouter({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.AGENTROUTER_API_KEY!
});

const firstTurn = await runAgent({
  client,
  task: "Create src/fib.ts with a fib(n) function.",
  runtime: codex({ mode: "full_access" })
});

const secondTurn = await streamAgent({
  client,
  continueRun: firstTurn.id,
  message: "Now add tests for fib(n)."
});

for await (const part of secondTurn.fullStream) {
  if (part.type === "progress") console.log(part.text);
  if (part.type === "text") process.stdout.write(part.text);
}

await client.closeRun(firstTurn.id);
```

You can also continue and wait in one call:

```ts
const result = await runAgent({
  client,
  continueRun: firstTurn.id,
  message: "Add edge-case tests for n = 0 and n = 1."
});
```

## Claude Code runs

Use `claudeCode` instead of `codex` to run the same workflow through Claude
Code.

```ts
import { agentrouter, claudeCode, runAgent } from "@agentrouterhq/sdk";

const client = agentrouter({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.AGENTROUTER_API_KEY!
});

const result = await runAgent({
  client,
  task: "Review the current repository and suggest the highest-impact cleanup.",
  runtime: claudeCode({ permissionMode: "default", model: "claude-sonnet-4-6" })
});

console.log(result.text);
```

## Low-level client

The helper functions are built on top of a small typed client. Use it directly
when you need more control.

```ts
const run = await client.createRun({
  task: "Run the test suite and summarize failures.",
  runtime: codex({ mode: "read_only" }),
  metadata: { source: "ci" },
  idempotencyKey: "pr-123-review"
});

for await (const event of client.streamRun(run.id)) {
  console.log(event.sequence, event.type);
}

const runSession = await client.getRunSession(run.id);
const artifacts = await client.listRunArtifacts(run.id);
```

Available client methods:

| Method | Purpose |
| --- | --- |
| `createRun` | Queue a new agent run |
| `createRunAndWait` | Queue a run and wait for the final run session snapshot |
| `getRun`, `listRuns`, `cancelRun` | Inspect and control runs |
| `listRunEvents`, `streamRun` | Read observable run events |
| `getRunSession` | Get the final run response, event cursor, and artifact manifest |
| `listRunArtifacts`, `downloadArtifact` | Inspect and download artifacts |
| `continueRun`, `getRunTurns`, `closeRun` | Continue, inspect, or close a run-id conversation |

## Runtime options

Codex:

```ts
codex({ mode: "default", model: "gpt-4o" });
codex({ mode: "read_only" });
codex({ mode: "full_access" });
codex({ mode: "auto_review" });
```

Claude Code:

```ts
claudeCode({ permissionMode: "default" });
claudeCode({ permissionMode: "plan" });
claudeCode({ permissionMode: "acceptEdits" });
claudeCode({ permissionMode: "bypassPermissions" });
```

## Custom headers and fetch

Use `defaultHeaders` when your self-hosted deployment needs per-client headers,
for example tenant routing or internal request metadata.

```ts
const client = agentrouter({
  baseUrl: "https://agentrouter.example.com",
  apiKey: process.env.AGENTROUTER_API_KEY!,
  defaultHeaders: {
    "x-workspace-id": "workspace_123"
  }
});
```

Use `fetchImpl` when your runtime needs a custom fetch implementation.

```ts
const client = agentrouter({
  apiKey: process.env.AGENTROUTER_API_KEY!,
  fetchImpl: customFetch
});
```

## Error handling

API errors and wait timeouts throw `AgentRouterError`.

```ts
import { AgentRouterError, agentrouter, codex, runAgent } from "@agentrouterhq/sdk";

const client = agentrouter({
  baseUrl: "http://127.0.0.1:8787",
  apiKey: process.env.AGENTROUTER_API_KEY!
});

try {
  await runAgent({
    client,
    task: "Run tests.",
    runtime: codex({ mode: "default" }),
    maxWaitMs: 60_000
  });
} catch (error) {
  if (error instanceof AgentRouterError) {
    console.error(error.code);
    console.error(error.statusCode);
    console.error(error.details);
  } else {
    throw error;
  }
}
```

Common SDK-side error codes:

| Code | Meaning |
| --- | --- |
| `wait_timeout` | A run did not reach a terminal state before `maxWaitMs` |
| `invalid_run_agent_request` | `runAgent` received neither a new task nor a continuation message |

Server-side API errors keep the error code returned by the AgentRouter API.

## Security notes

- Keep `AGENTROUTER_API_KEY` on the server side. Do not ship it to an
  untrusted browser client.
- Provider keys stay in the AgentRouter runtime environment, not in SDK calls.
- `fullStream` exposes observable progress and final output, not hidden
  chain-of-thought.
- Agent commands run inside the sandbox provider configured by your
  self-hosted runtime.

## Links

- [GitHub repository](https://github.com/perixtar/AgentRouter)
- [Self-hosting guide](https://github.com/perixtar/AgentRouter/blob/main/docs/self-hosting.md)
- [Examples](https://github.com/perixtar/AgentRouter/tree/main/examples)
- [Security policy](https://github.com/perixtar/AgentRouter/blob/main/SECURITY.md)
