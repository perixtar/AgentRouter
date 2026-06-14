import { streamAgent } from "@agentrouterhq/sdk";
import {
  codexRuntime,
  handleExampleError,
  hasHelpFlag,
  makeExampleClient
} from "../shared.js";

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
      "Use the shell tool to run exactly this failing command three separate times without changing it: bash -lc 'echo AR_NO_PROGRESS_EXAMPLE && exit 1'. After the third failed attempt, run exactly: mkdir -p reports && printf 'AR_NO_PROGRESS_EXAMPLE_OK\\n' > reports/no-progress-example.txt. Then summarize the change in one sentence.",
    runtime: codexRuntime("full_access"),
    approvalMode: "manual",
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000
  });

  console.log(`API: ${baseUrl}`);
  console.log(`Run ${stream.run.id}: ${stream.run.status}`);
  console.log("Streaming run events and watching for no-progress signals:");

  const approvedActions = new Set<string>();
  let sawNoProgress = false;

  for await (const part of stream.fullStream) {
    if (part.type === "action") {
      console.log(`action: ${part.text}`);
    } else if (part.type === "approval_request") {
      console.log(`approval requested: ${part.actionId}`);
      if (!approvedActions.has(part.actionId)) {
        approvedActions.add(part.actionId);
        await client.approveRunAction({
          runId: stream.run.id,
          actionId: part.actionId,
          actionDigest: part.actionDigest,
          reason: "Approved by examples/recipes/no-progress.ts"
        });
      }
    } else if (part.type === "no_progress") {
      sawNoProgress = true;
      console.log(`no progress (${part.signal}): ${part.text}`);
    } else if (part.type === "execution") {
      console.log(`execution: ${part.status}`);
    } else if (part.type === "progress") {
      console.log(`process: ${part.text}`);
    } else if (part.type === "message") {
      console.log(`agent: ${part.text}`);
    } else if (part.type === "text") {
      console.log(`final: ${part.text}`);
    } else if (part.type === "error") {
      console.log(`error: ${part.text}`);
    } else if (part.type === "done") {
      console.log(`done: ${part.status}`);
    }
  }

  const result = await stream.finalResult;
  console.log(`Final status: ${result.status}`);
  console.log(`No-progress signal seen: ${sawNoProgress ? "yes" : "no"}`);
  console.log(`Last event sequence: ${result.eventCursor.lastEventSeq}`);
} catch (error) {
  handleExampleError(error);
}

function printHelp(): void {
  console.log(`no-progress recipe

Runs a Codex coding-agent task that intentionally repeats a failing command, then
prints the SDK's no-progress stream part when AgentRouter detects the loop.

Problem:
  Production agents can get stuck repeating the same failed command, retrying the
  same edit, or producing lots of output without real state changes.

Solution:
  AgentRouter emits agent.no_progress as a persisted run event and exposes it as
  part.type === "no_progress" in stream.fullStream. Your product can warn the
  user, request approval, cancel, retry, or continue from the current sandbox.

Prerequisites:
  pnpm dev

Run:
  pnpm example:recipe:no-progress

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
  AGENTROUTER_MODEL=gpt-4o
  AGENTROUTER_TASK="Run a task that may repeat failed commands"
`);
}
