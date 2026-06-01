import { config as loadDotEnv } from "dotenv";
import {
  AgentRouterError,
  agentrouter,
  codex,
  runAgent,
  type RunEvent
} from "@agentrouter/sdk";

loadDotEnv();

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

const baseUrl =
  process.env.AGENTROUTER_API_BASE_URL ??
  process.env.AGENTROUTER_BASE_URL ??
  "http://127.0.0.1:8787";
const apiKey = process.env.AGENTROUTER_API_KEY ?? "ar_dev_local_change_me";
const runtimeModel = process.env.AGENTROUTER_MODEL;

const client = agentrouter({
  baseUrl,
  apiKey
});

try {
  console.log(`Creating Codex run against ${baseUrl}`);

  const session = await runAgent({
    client,
    task: "Reply exactly AR_CODEX_SDK_EXAMPLE_OK. Do not edit files.",
    runtime: codex({ mode: "default", ...(runtimeModel ? { model: runtimeModel } : {}) }),
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000,
    onEvent: logEvent
  });

  console.log(`Run ${session.run.id}: ${session.run.status}`);
  console.log(`Last event sequence: ${session.eventCursor.lastEventSeq}`);
  console.log(`Manifest: ${String(session.artifactManifest.status ?? "unknown")}`);
  console.log(
    `Artifacts: ${session.artifacts.items.map((artifact) => artifact.kind).join(", ") || "(none)"}`
  );

  if (session.run.status !== "completed") {
    console.error(`Run ended as ${session.run.status}`);
    if (session.run.failure) {
      console.error(JSON.stringify(session.run.failure, null, 2));
    }
    process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof AgentRouterError && error.code === "wait_timeout") {
    console.error("Timed out waiting for the run. Make sure `pnpm worker:dev` is running.");
    process.exitCode = 1;
  } else if (error instanceof AgentRouterError) {
    console.error(`AgentRouter API error: ${error.code}: ${error.message}`);
    if (error.details) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exitCode = 1;
  } else {
    throw error;
  }
}

function logEvent(event: RunEvent): void {
  const message =
    typeof event.payload.message === "string"
      ? event.payload.message
      : typeof event.payload.text === "string"
        ? event.payload.text
        : "";
  const preview = message.slice(0, 160).replaceAll("\n", " ");
  console.log(`event #${event.sequence} ${event.type}${preview ? `: ${preview}` : ""}`);
}

function printHelp(): void {
  console.log(`AgentRouter TypeScript SDK minimal example

Prerequisites:
  pnpm dev

Or run the processes separately:
  pnpm api:dev
  pnpm worker:dev

Run:
  pnpm example:sdk

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=ar_dev_local_change_me
  AGENTROUTER_MODEL=gpt-4o
`);
}
