import { runAgent } from "@agentrouterhq/sdk";
import {
  codexRuntime,
  handleExampleError,
  hasHelpFlag,
  logRunEvent,
  makeExampleClient
} from "../shared.js";

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

try {
  const { baseUrl, client } = makeExampleClient();
  const result = await runAgent({
    client,
    task:
      process.env.AGENTROUTER_TASK ??
      "Inspect this repo and summarize what AgentRouter does. Do not edit files.",
    runtime: codexRuntime("default"),
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000,
    onEvent: logRunEvent
  });

  console.log(`API: ${baseUrl}`);
  console.log(`Run ${result.id}: ${result.status}`);
  console.log(`Last event sequence: ${result.eventCursor.lastEventSeq}`);
  console.log("\nAgent response:");
  console.log(result.text || "(no text response)");
} catch (error) {
  handleExampleError(error);
}

function printHelp(): void {
  console.log(`runAgent example

Creates a Codex run, waits for completion, and prints result.text.

Prerequisites:
  pnpm dev

Or run the processes separately:
  pnpm api:dev
  pnpm worker:dev

Run:
  pnpm example:quickstart:run

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
  AGENTROUTER_MODEL=gpt-4o
  AGENTROUTER_TASK="Summarize this repo"
`);
}
