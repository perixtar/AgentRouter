import { config as loadDotEnv } from "dotenv";
import { AgentRouterError, agentrouter, codex, type RunEvent } from "@agentrouter/sdk";

loadDotEnv();

export function makeExampleClient() {
  const baseUrl =
    process.env.AGENTROUTER_API_BASE_URL ??
    process.env.AGENTROUTER_BASE_URL ??
    "http://127.0.0.1:8787";
  const apiKey = process.env.AGENTROUTER_API_KEY ?? "ar_dev_local_change_me";

  return {
    baseUrl,
    apiKey,
    client: agentrouter({ baseUrl, apiKey })
  };
}

export function codexRuntime(mode: "default" | "read_only" | "full_access" | "auto_review" = "default") {
  const runtimeModel = process.env.AGENTROUTER_MODEL;
  return codex({ mode, ...(runtimeModel ? { model: runtimeModel } : {}) });
}

export function logRunEvent(event: RunEvent): void {
  const message =
    typeof event.payload.message === "string"
      ? event.payload.message
      : typeof event.payload.text === "string"
        ? event.payload.text
        : "";
  const preview = message.slice(0, 160).replaceAll("\n", " ");
  console.log(`event #${event.sequence} ${event.type}${preview ? `: ${preview}` : ""}`);
}

export function handleExampleError(error: unknown): void {
  if (error instanceof AgentRouterError && error.code === "wait_timeout") {
    console.error("Timed out waiting for the run. Make sure `pnpm worker:dev` is running.");
    process.exitCode = 1;
    return;
  }

  if (error instanceof AgentRouterError) {
    console.error(`AgentRouter API error: ${error.code}: ${error.message}`);
    if (error.details) {
      console.error(JSON.stringify(error.details, null, 2));
    }
    process.exitCode = 1;
    return;
  }

  throw error;
}

export function hasHelpFlag(): boolean {
  return process.argv.includes("--help") || process.argv.includes("-h");
}
