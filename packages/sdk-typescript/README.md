# AgentRouter TypeScript SDK

Run and stream AgentRouter coding-agent sessions from TypeScript.

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

Stream safe process updates and final output:

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
