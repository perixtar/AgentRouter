import { runAgent } from "@agentrouter/sdk";
import {
  claudeCodeRuntime,
  handleExampleError,
  hasHelpFlag,
  logRunEvent,
  makeExampleClient
} from "./shared.js";

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
      "Reply exactly AR_CLAUDE_CODE_EXAMPLE_OK. Do not edit files.",
    runtime: claudeCodeRuntime("default"),
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000,
    onEvent: logRunEvent
  });

  console.log(`API: ${baseUrl}`);
  console.log(`Run ${result.id}: ${result.status}`);
  console.log(`Last event sequence: ${result.eventCursor.lastEventSeq}`);
  console.log("\nAgent response:");
  console.log(result.text || "(no text response)");

  if (result.status !== "completed") {
    console.error(`Run ended as ${result.status}`);
    if (result.run.failure) console.error(JSON.stringify(result.run.failure, null, 2));
    process.exit(1);
  }
} catch (error) {
  handleExampleError(error);
}

function printHelp(): void {
  console.log(`Claude Code runAgent example

Creates a Claude Code run and prints result.text.

Prerequisites:
  pnpm dev

Run:
  pnpm example:claude-code

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
  AGENTROUTER_CLAUDE_MODEL=claude-sonnet-4-6
  AGENTROUTER_TASK="Summarize this repo"
`);
}
