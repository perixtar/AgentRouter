import { streamAgent } from "@agentrouter/sdk";
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
  console.log("Streaming agent response:");

  for await (const textPart of stream.textStream) {
    process.stdout.write(textPart);
  }
  process.stdout.write("\n");

  const result = await stream.finalResult;
  console.log(`Final status: ${result.status}`);
  console.log(`Last event sequence: ${result.eventCursor.lastEventSeq}`);
} catch (error) {
  handleExampleError(error);
}

function printHelp(): void {
  console.log(`streamAgent example

Creates a Codex run, streams result text until the run is terminal, then prints
the final status.

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
