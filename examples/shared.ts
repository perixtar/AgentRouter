import { config as loadDotEnv } from "dotenv";
import {
  AgentRouterError,
  agentrouter,
  claudeCode,
  codex,
  type RunEvent
} from "@agentrouterhq/sdk";

loadDotEnv();

export function makeExampleClient() {
  const baseUrl =
    process.env.AGENTROUTER_API_BASE_URL ??
    process.env.AGENTROUTER_BASE_URL ??
    "http://127.0.0.1:8787";
  const apiKey = requireExampleApiKey();

  return {
    baseUrl,
    apiKey,
    client: agentrouter({ baseUrl, apiKey })
  };
}

function requireExampleApiKey(): string {
  const apiKey = process.env.AGENTROUTER_API_KEY;
  if (!apiKey || apiKey === "ar_dev_local_change_me") {
    throw new Error("Set AGENTROUTER_API_KEY to the private bearer token configured for the API");
  }
  return apiKey;
}

export function codexRuntime(mode: "default" | "read_only" | "full_access" | "auto_review" = "default") {
  const runtimeModel = process.env.AGENTROUTER_MODEL;
  return codex({ mode, ...(runtimeModel ? { model: runtimeModel } : {}) });
}

export function claudeCodeRuntime(
  permissionMode: "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions" = "default"
) {
  const runtimeModel = process.env.AGENTROUTER_CLAUDE_MODEL ?? process.env.AGENTROUTER_MODEL;
  return claudeCode({ permissionMode, ...(runtimeModel ? { model: runtimeModel } : {}) });
}

export function logRunEvent(event: RunEvent): void {
  const preview = runEventPreview(event);
  console.log(`event #${event.sequence} ${event.type}${preview ? `: ${preview}` : ""}`);
}

function runEventPreview(event: RunEvent): string {
  if (event.type === "action.proposed") {
    const name = actionName(event.payload);
    const digest = typeof event.payload.actionDigest === "string" ? event.payload.actionDigest : "";
    return `${name}${digest ? ` ${digest.slice(0, 24)}...` : ""}`;
  }

  if (event.type === "policy.evaluated") {
    const decision = typeof event.payload.decision === "string" ? event.payload.decision : "unknown";
    const policyId = typeof event.payload.policyId === "string" ? event.payload.policyId : "policy";
    return `${policyId} ${decision}`;
  }

  if (event.type === "approval.requested") {
    return `waiting for approval of ${actionName(event.payload)}`;
  }

  if (event.type === "approval.decided") {
    const decision = typeof event.payload.decision === "string" ? event.payload.decision : "unknown";
    return `approval ${decision}`;
  }

  if (event.type.startsWith("execution.")) {
    const status = typeof event.payload.status === "string" ? event.payload.status : event.type.split(".")[1];
    return `runtime ${status}`;
  }

  const message =
    typeof event.payload.message === "string"
      ? event.payload.message
      : typeof event.payload.text === "string"
        ? event.payload.text
        : "";
  return message.slice(0, 160).replaceAll("\n", " ");
}

function actionName(payload: Record<string, unknown>): string {
  const action = payload.action;
  if (action && typeof action === "object") {
    const name = (action as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }

  return typeof payload.actionName === "string" ? payload.actionName : "runtime action";
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

  if (error instanceof Error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  throw error;
}

export function hasHelpFlag(): boolean {
  return process.argv.includes("--help") || process.argv.includes("-h");
}
