# AgentRouter TypeScript SDK

Run, **continue**, and stream AgentRouter coding-agent runs from TypeScript. A run id is the conversation handle — start with `createRun`, then continue the same conversation by that id.

```ts
import { agentrouter, codex, runAgent, streamAgent } from "@agentrouter/sdk";

const ar = agentrouter({
  baseUrl: "https://agentrouter-dev.fly.dev",
  apiKey: process.env.AGENTROUTER_API_KEY!
});

const result = await runAgent({
  client: ar,
  task: "Create reports/agent-smoke.txt",
  runtime: codex({ mode: "default", model: "gpt-4o" })
});

console.log(result.text);
```

## Multi-turn: continue a conversation by run id

`POST /v1/runs` is unchanged (returns a `runId`). To add a follow-up turn, continue **by that run id** — it resumes the same sandbox + Codex thread (within the grace window) so turn 2 sees turn 1's files and context.

```ts
// Turn 1
const run = await ar.createRun({
  task: "Write fib.py with a fib(n) function",
  runtime: codex({ mode: "full_access" })
});
// …wait for `run` to complete…

// Turn 2 — continue by the run id
const turn2 = await ar.continueRun(run.id, "Now add a test for it");
// → { runId, turnNumber: 2, conversationId: run.id }

// Inspect the whole conversation
const { conversationId, items } = await ar.getRunTurns(run.id);

// Reclaim the sandbox immediately when you're done
await ar.closeRun(run.id);
```

One-call continue-and-wait, or stream the new turn:

```ts
// continue + wait for the new turn to finish
const result = await runAgent({
  client: ar,
  continueRun: run.id,        // the conversation handle
  message: "Now add a docstring"
});

// or stream the new turn's events/text
import { continueAgent } from "@agentrouter/sdk";
const stream = await continueAgent({ client: ar, runId: run.id, message: "Refactor it" });
for await (const part of stream.fullStream) {
  if (part.type === "progress") console.log(part.text);
  if (part.type === "text") process.stdout.write(part.text);
}
```

> Note: `runAgent` no longer accepts a `sessionId`. Resume is now `runAgent({ continueRun, message })` — it actually sends the message and waits for the **new** turn (the old `sessionId` shape passed a runId into a run endpoint and only waited, never continued).

## Streaming a single run

```ts
const stream = await streamAgent({
  client: ar,
  task: "Inspect the repo and summarize the change",
  runtime: codex({ mode: "default" })
});

for await (const part of stream.fullStream) {
  if (part.type === "progress") console.log(part.text);
  if (part.type === "text") process.stdout.write(part.text);
}
```

`fullStream` exposes safe progress summaries and observable activity. It does not expose raw hidden model chain-of-thought.

## Acting on behalf of an org (server / web)

External customers authenticate with their own `ar_live_…` key (it already resolves their org). A trusted server (e.g. the web backend) can instead present the shared web service token and assert the org via the `X-AR-Org-Id` header by passing `orgId`:

```ts
const ar = agentrouter({
  baseUrl: process.env.AGENTROUTER_API_URL,
  apiKey: process.env.AGENTROUTER_WEB_SERVICE_TOKEN!,
  orgId: resolvedOrgId           // → sends `X-AR-Org-Id: <orgId>` on every request
});
```

Use `defaultHeaders` for any other per-client headers.
