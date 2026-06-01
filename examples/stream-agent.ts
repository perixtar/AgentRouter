import { streamAgent } from "@agentrouter/sdk";
import {
  codexRuntime,
  handleExampleError,
  hasHelpFlag,
  logRunEvent,
  makeExampleClient
} from "./shared.js";

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

const { baseUrl, client } = makeExampleClient();

try {
  const stream = await streamAgent({
    client,
    task:
      process.env.AGENTROUTER_TASK ??
      "Reply exactly AR_STREAM_AGENT_EXAMPLE_OK. Do not edit files.",
    runtime: codexRuntime("default"),
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000
  });

  console.log(`API: ${baseUrl}`);
  console.log(`Run ${stream.run.id}: ${stream.run.status}`);
  console.log("Streaming normalized events:");

  for await (const event of stream.events) {
    logRunEvent(event);
  }

  const session = await stream.finalSession;
  console.log(`Final status: ${session.run.status}`);
  console.log(`Last event sequence: ${session.eventCursor.lastEventSeq}`);
  console.log(
    `Artifacts: ${session.artifacts.items.map((artifact) => artifact.kind).join(", ") || "(none)"}`
  );
} catch (error) {
  handleExampleError(error);
}

function printHelp(): void {
  console.log(`streamAgent example

Creates a Codex run, streams normalized events until the run is terminal, then
prints the restored session and artifacts.

Prerequisites:
  1. pnpm api:dev
  2. pnpm worker:dev

Run:
  pnpm example:stream-agent

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=ar_dev_local_change_me
  AGENTROUTER_MODEL=gpt-4o
  AGENTROUTER_TASK="Create reports/stream-example.txt"
`);
}
