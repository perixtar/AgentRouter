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
      "Reply exactly AR_APPROVAL_EVENTS_EXAMPLE_OK. Do not edit files.",
    runtime: codexRuntime("default"),
    approvalMode: "manual",
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000
  });

  console.log(`API: ${baseUrl}`);
  console.log(`Run ${stream.run.id}: ${stream.run.status}`);
  console.log("Streaming action, policy, approval, execution, and agent events:");

  const approvedActions = new Set<string>();
  for await (const part of stream.fullStream) {
    if (part.type === "action") {
      console.log(`action: ${part.text} (${part.actionId})`);
    } else if (part.type === "approval_request") {
      console.log(`approval requested: ${part.actionId}`);
      if (!approvedActions.has(part.actionId)) {
        approvedActions.add(part.actionId);
        await client.approveRunAction({
          runId: stream.run.id,
          actionId: part.actionId,
          actionDigest: part.actionDigest,
          reason: "Approved by examples/recipes/approval-events.ts"
        });
      }
    } else if (part.type === "approval_decision") {
      console.log(`approval decision: ${part.decision}`);
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
  console.log(`Last event sequence: ${result.eventCursor.lastEventSeq}`);
} catch (error) {
  handleExampleError(error);
}

function printHelp(): void {
  console.log(`approval events recipe

Creates a Codex run with approvalMode="manual", streams the SDK's high-level
event parts, approves the provider runtime action, and waits for completion.

This demonstrates why the new event parts exist:
  action              what AgentRouter is about to execute
  progress            includes policy.evaluated, which explains allow/block/approval
  approval_request    where your product can pause for a human or policy gate
  approval_decision   the immutable approve/deny decision
  execution           when the approved action actually starts and finishes

Prerequisites:
  pnpm dev

Run:
  pnpm example:recipe:approval-events

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
  AGENTROUTER_MODEL=gpt-4o
  AGENTROUTER_TASK="Create reports/approval-events.txt"
`);
}
