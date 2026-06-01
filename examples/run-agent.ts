import { runAgent } from "@agentrouter/sdk";
import {
  codexRuntime,
  handleExampleError,
  hasHelpFlag,
  logRunEvent,
  makeExampleClient,
} from "./shared.js";

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

const sessionId = process.env.AGENTROUTER_SESSION_ID;
const afterSeq = Number(process.env.AGENTROUTER_AFTER_SEQ ?? "0");

try {
  const { baseUrl, client } = makeExampleClient();
  const result = sessionId
    ? await runAgent({
        client,
        sessionId,
        afterSeq,
        pollIntervalMs: 1000,
        maxWaitMs: 10 * 60 * 1000,
        onEvent: logRunEvent,
      })
    : await runAgent({
        client,
        task:
          process.env.AGENTROUTER_TASK ??
          "Please explain to me what is forward deployment engineer. Do not edit files.",
        runtime: codexRuntime("default"),
        pollIntervalMs: 1000,
        maxWaitMs: 10 * 60 * 1000,
        onEvent: logRunEvent,
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

Creates a Codex run and prints result.text. To resume an existing run instead
of creating a new one, set AGENTROUTER_SESSION_ID.

Prerequisites:
  pnpm dev

Or run the processes separately:
  pnpm api:dev
  pnpm worker:dev

Run:
  pnpm example:run-agent

Resume:
  AGENTROUTER_SESSION_ID=run_... AGENTROUTER_AFTER_SEQ=0 pnpm example:run-agent

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
  AGENTROUTER_MODEL=gpt-4o
  AGENTROUTER_TASK="Summarize this repo"
`);
}
