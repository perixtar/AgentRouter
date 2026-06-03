import { codex } from "@agentrouterhq/sdk";
import { handleExampleError, hasHelpFlag, makeExampleClient } from "../shared.js";

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

try {
  const { baseUrl, client } = makeExampleClient();
  console.log(`API: ${baseUrl}`);

  const run = await client.createRun({
    task: "Queued for the low-level client example. This run will be cancelled before worker claim.",
    runtime: codex({ mode: "read_only" }),
    metadata: {
      example: "low-level-client",
      purpose: "control-plane"
    },
    idempotencyKey: `example-low-level-${Date.now()}`
  });

  console.log(`Created run ${run.id} with status=${run.status}`);

  const listed = await client.listRuns({ limit: 5 });
  console.log(`Recent visible runs: ${listed.items.map((item) => item.id).join(", ")}`);

  const eventsBeforeCancel = await client.listRunEvents(run.id);
  console.log(`Events before cancel: ${eventsBeforeCancel.items.length}`);

  const cancelled = await client.cancelRun(run.id);
  console.log(`Cancel requested: status=${cancelled.status}`);

  const restored = await client.getRun(run.id);
  console.log(`Restored run: status=${restored.status}, lastEventSeq=${restored.lastEventSeq}`);
} catch (error) {
  handleExampleError(error);
}

function printHelp(): void {
  console.log(`low-level client recipe

Demonstrates the typed client methods directly: createRun, listRuns,
listRunEvents, cancelRun, and getRun.

This is intentionally API-only. Run the API without the worker if you want to
guarantee the run remains queued until cancellation:

  pnpm api:dev

Run:
  pnpm example:recipe:low-level

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
`);
}
