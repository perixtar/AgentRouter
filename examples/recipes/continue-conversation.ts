import { streamAgent } from "@agentrouterhq/sdk";
import {
  codexRuntime,
  handleExampleError,
  hasHelpFlag,
  makeExampleClient
} from "../shared.js";

const marker1 = "AR_CONTINUE_TURN1_OK";
const marker2 = "AR_CONTINUE_TURN2_OK";

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

const { baseUrl, client } = makeExampleClient();
let conversationRunId: string | undefined;

try {
  console.log(`API: ${baseUrl}`);
  console.log("Starting turn 1 in a persistent Codex sandbox...");

  const first = await streamAgent({
    client,
    task:
      process.env.AGENTROUTER_TASK ??
      `Use the shell tool to run exactly: mkdir -p reports && printf '${marker1}\\n' > reports/turn1.txt. Then summarize the change in one sentence.`,
    runtime: codexRuntime("full_access"),
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000
  });
  conversationRunId = first.run.id;

  for await (const part of first.fullStream) {
    printStreamPart("turn 1", part);
  }
  const firstResult = await first.finalResult;
  assertCompleted(firstResult.status, "turn 1");

  console.log("\nContinuing the same conversation and sandbox...");
  const second = await streamAgent({
    client,
    continueRun: firstResult.id,
    message:
      process.env.AGENTROUTER_MESSAGE ??
      `Use the shell tool to run exactly: grep -qx '${marker1}' reports/turn1.txt && printf '${marker2}\\n' > reports/turn2.txt. Then summarize what persisted across turns.`,
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000
  });

  for await (const part of second.fullStream) {
    printStreamPart("turn 2", part);
  }
  const secondResult = await second.finalResult;
  assertCompleted(secondResult.status, "turn 2");

  const turns = await client.getRunTurns(firstResult.id);
  console.log("\nConversation turns:");
  for (const turn of turns.items) {
    console.log(`  #${turn.turnNumber} ${turn.runId}: ${turn.prompt.slice(0, 90)}`);
  }

  const closed = await client.closeRun(firstResult.id);
  conversationRunId = undefined;
  console.log(`\nClosed conversation ${closed.conversationId}; reclaimed=${closed.reclaimed}`);
} catch (error) {
  handleExampleError(error);
} finally {
  if (conversationRunId) {
    await client.closeRun(conversationRunId).catch(() => undefined);
  }
}

function printStreamPart(
  turn: string,
  part:
    | { type: "progress"; text: string }
    | { type: "message"; text: string }
    | { type: "text"; text: string }
    | { type: "error"; text: string }
    | { type: "done"; status: string }
): void {
  if (part.type === "done") {
    console.log(`${turn}: ${part.status}`);
    return;
  }
  console.log(`${turn} ${part.type}: ${part.text.replaceAll("\n", " ").slice(0, 240)}`);
}

function assertCompleted(status: string, label: string): void {
  if (status !== "completed") {
    throw new Error(`${label} ended as ${status}`);
  }
}

function printHelp(): void {
  console.log(`continue conversation recipe

Runs two Codex turns against the same run-id conversation. Turn 2 verifies a
file written by turn 1, proving the sandbox and provider session were resumed.
The recipe closes the conversation at the end so the sandbox can be reclaimed.

Prerequisite:
  pnpm dev

Run:
  pnpm example:recipe:continue

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
  AGENTROUTER_MODEL=gpt-4o
  AGENTROUTER_TASK="Create a first file"
  AGENTROUTER_MESSAGE="Use the first file and create a second file"
`);
}
