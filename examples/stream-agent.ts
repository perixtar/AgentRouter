import { streamAgent } from "@agentrouterhq/sdk";
import {
  codexRuntime,
  handleExampleError,
  hasHelpFlag,
  makeExampleClient
} from "./shared.js";

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

try {
  const { baseUrl, client } = makeExampleClient();
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
  console.log("Streaming agent process and final response:");

  for await (const part of stream.fullStream) {
    if (part.type === "progress") {
      console.log(`process: ${part.text}`);
    } else if (part.type === "message") {
      console.log(`agent: ${part.text}`);
    } else if (part.type === "text") {
      console.log(`final: ${part.text}`);
    } else if (part.type === "error") {
      console.log(`error: ${part.text}`);
    }
  }

  const result = await stream.finalResult;
  console.log(`Final status: ${result.status}`);
  console.log(`Last event sequence: ${result.eventCursor.lastEventSeq}`);
} catch (error) {
  handleExampleError(error);
}

function printHelp(): void {
  console.log(`streamAgent example

Creates a Codex run, streams safe process updates and final output until the run
is terminal, then prints the final status.

Prerequisites:
  pnpm dev

Or run the processes separately:
  pnpm api:dev
  pnpm worker:dev

Run:
  pnpm example:stream-agent

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
  AGENTROUTER_MODEL=gpt-4o
  AGENTROUTER_TASK="Create reports/stream-example.txt"
`);
}
