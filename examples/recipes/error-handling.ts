import { AgentRouterError, codex } from "@agentrouterhq/sdk";
import { handleExampleError, hasHelpFlag, makeExampleClient } from "../shared.js";

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

try {
  const { baseUrl, client } = makeExampleClient();
  console.log(`API: ${baseUrl}`);
  console.log("Sending an intentionally invalid model name to demonstrate AgentRouterError...");

  await client.createRun({
    task: "This request should be rejected before any worker can claim it.",
    runtime: codex({ mode: "default", model: "not a valid model name" })
  });

  throw new Error("Expected the API to reject the invalid model name");
} catch (error) {
  if (error instanceof AgentRouterError) {
    console.log(`Caught AgentRouterError: code=${error.code}, status=${error.statusCode}`);
    if (error.details) console.log(JSON.stringify(error.details, null, 2));
    if (error.statusCode !== 400) {
      process.exitCode = 1;
    }
  } else {
    handleExampleError(error);
  }
}

function printHelp(): void {
  console.log(`error handling recipe

Demonstrates SDK error handling by sending a request that fails API validation
before any worker or provider runtime is involved.

Prerequisite:
  pnpm api:dev

Run:
  pnpm example:recipe:errors

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
`);
}
