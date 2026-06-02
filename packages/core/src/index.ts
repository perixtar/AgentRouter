export type RuntimeKind = "codex" | "claude_code";
export type CodexRuntimeMode = "default" | "read_only" | "full_access" | "auto_review";
export type ClaudeCodePermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";
export type RuntimeModel = string;
export type RuntimePermissionValue = CodexRuntimeMode | ClaudeCodePermissionMode;

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "cancelled"
  | "completed"
  | "failed";

const terminalStatuses = new Set<RunStatus>(["cancelled", "completed", "failed"]);

const allowedTransitions: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["starting", "cancelling", "failed"]),
  starting: new Set(["running", "cancelling", "failed"]),
  running: new Set(["completed", "cancelling", "failed"]),
  cancelling: new Set(["cancelled", "failed"]),
  cancelled: new Set(),
  completed: new Set(),
  failed: new Set()
};

export function transitionRunStatus(current: RunStatus, next: RunStatus): RunStatus {
  if (terminalStatuses.has(current)) {
    throw new Error(`Cannot transition from terminal state ${current} to ${next}`);
  }

  if (!allowedTransitions[current].has(next)) {
    throw new Error(`Illegal run status transition ${current} -> ${next}`);
  }

  return next;
}

export interface ArtifactRef {
  artifactId: string;
  r2Key: string;
}

export interface NormalizedEventPayload {
  payload: Record<string, unknown>;
  payloadSizeBytes: number;
  isTruncated: boolean;
  artifactRef?: ArtifactRef;
}

export interface AgentResponseTextPart {
  type: "text";
  text: string;
}

export interface AgentResponse {
  text: string;
  parts: AgentResponseTextPart[];
  providerEventType?: string;
}

export type NormalizedAgentEventType =
  | "agent.started"
  | "agent.progress"
  | "agent.message"
  | "agent.completed"
  | "agent.error";

export interface NormalizedAgentEvent {
  type: NormalizedAgentEventType;
  visibility: "public";
  providerEventType?: string;
  payload: Record<string, unknown>;
}

const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_PUBLIC_TEXT_BYTES = 8 * 1024;

export function normalizeEventPayload(
  payload: Record<string, unknown>,
  artifactRef?: ArtifactRef
): NormalizedEventPayload {
  const inlinePayload = truncateLargeStrings(payload);
  let payloadSizeBytes = byteLengthJson(inlinePayload);
  let isTruncated = payloadSizeBytes > MAX_PAYLOAD_BYTES || artifactRef !== undefined;

  if (payloadSizeBytes > MAX_PAYLOAD_BYTES) {
    inlinePayload.truncated = true;
    inlinePayload.truncationReason = "payload_size_limit";
    payloadSizeBytes = byteLengthJson(inlinePayload);
  }

  return {
    payload: inlinePayload,
    payloadSizeBytes,
    isTruncated,
    artifactRef
  };
}

function truncateLargeStrings(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" && byteLength(value) > MAX_PUBLIC_TEXT_BYTES) {
      result[key] = truncateUtf8(value, MAX_PUBLIC_TEXT_BYTES);
      result[`${key}Truncated`] = true;
      continue;
    }

    result[key] = value;
  }

  return result;
}

function byteLengthJson(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = "";
  let used = 0;

  for (const char of value) {
    const size = byteLength(char);
    if (used + size > maxBytes) break;
    output += char;
    used += size;
  }

  return output;
}

export function extractAgentResponseFromStdout(stdout: string): AgentResponse | undefined {
  const responses: AgentResponse[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const event = parseJsonLine(line);
    if (!event) continue;

    const text =
      extractCodexAgentMessage(event) ??
      extractClaudeAssistantMessage(event) ??
      extractProviderResultMessage(event) ??
      extractGenericProviderMessage(event);

    if (text) {
      responses.push({
        text,
        parts: [{ type: "text", text }],
        providerEventType: typeof event.type === "string" ? event.type : undefined
      });
    }
  }

  return responses.at(-1);
}

export function extractNormalizedAgentEventsFromStdout(
  provider: RuntimeKind,
  stdout: string
): NormalizedAgentEvent[] {
  const events: NormalizedAgentEvent[] = [];
  let sawStarted = false;

  for (const line of stdout.split(/\r?\n/)) {
    const event = parseJsonLine(line);
    if (!event) continue;

    const providerEventType = typeof event.type === "string" ? event.type : undefined;
    const startedPayload = normalizeStartedPayload(provider, event);
    if (startedPayload && !sawStarted) {
      events.push({
        type: "agent.started",
        visibility: "public",
        providerEventType,
        payload: startedPayload
      });
      sawStarted = true;
    }

    const messageText =
      extractCodexAgentMessage(event) ??
      extractClaudeAssistantMessage(event) ??
      extractGenericProviderMessage(event);
    if (messageText) {
      events.push({
        type: "agent.message",
        visibility: "public",
        providerEventType,
        payload: { provider, text: messageText }
      });
    }

    const progressSummary = extractSafeProgressSummary(event);
    if (progressSummary) {
      events.push({
        type: "agent.progress",
        visibility: "public",
        providerEventType,
        payload: { provider, summary: progressSummary }
      });
    }

    const resultEvent = normalizeProviderResult(provider, event);
    if (resultEvent) {
      events.push({
        ...resultEvent,
        providerEventType
      });
    }
  }

  return events;
}

export function sanitizeProviderStdoutForArchive(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .map((line) => {
      const event = parseJsonLine(line);
      if (!event) return line;
      return JSON.stringify(sanitizeProviderEvent(event));
    })
    .join("\n");
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeProviderEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "reasoning") {
      return {
        ...event,
        item: compactRecord({
          type: item.type,
          summary: item.summary,
          status: item.status
        })
      };
    }
  }

  return event;
}

function extractCodexAgentMessage(event: Record<string, unknown>): string | undefined {
  if (event.type !== "item.completed") return undefined;
  const item = event.item;
  if (!item || typeof item !== "object") return undefined;
  const typedItem = item as { type?: unknown; text?: unknown };
  return typedItem.type === "agent_message" && typeof typedItem.text === "string"
    ? typedItem.text
    : undefined;
}

function extractClaudeAssistantMessage(event: Record<string, unknown>): string | undefined {
  if (event.type !== "assistant") return undefined;
  const message = event.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map((item) =>
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : ""
    )
    .filter(Boolean)
    .join("\n");

  return text || undefined;
}

function extractProviderResultMessage(event: Record<string, unknown>): string | undefined {
  if (event.type !== "result" || event.is_error === true) return undefined;
  return typeof event.result === "string" ? event.result : undefined;
}

function extractGenericProviderMessage(event: Record<string, unknown>): string | undefined {
  return event.type === "message" && typeof event.message === "string" ? event.message : undefined;
}

function extractSafeProgressSummary(event: Record<string, unknown>): string | undefined {
  if (event.type === "turn.started") return "Started a turn.";
  if (event.type === "turn.completed") return "Completed a turn.";
  if (event.type !== "item.completed") return undefined;

  const item = event.item;
  if (!item || typeof item !== "object") return undefined;
  const typedItem = item as { type?: unknown; summary?: unknown };
  if (typedItem.type !== "reasoning") return undefined;

  return extractSummaryText(typedItem.summary) ?? "Reasoning step completed.";
}

function extractSummaryText(summary: unknown): string | undefined {
  if (typeof summary === "string" && summary.trim()) return summary.trim();
  if (!Array.isArray(summary)) return undefined;

  const text = summary
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const maybeText = (item as { text?: unknown }).text;
      return typeof maybeText === "string" ? maybeText : "";
    })
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");

  return text || undefined;
}

function normalizeStartedPayload(
  provider: RuntimeKind,
  event: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (provider === "codex" && event.type === "thread.started") {
    return compactRecord({
      provider,
      threadId: typeof event.thread_id === "string" ? event.thread_id : undefined
    });
  }

  if (provider === "claude_code" && event.type === "system" && event.subtype === "init") {
    return compactRecord({
      provider,
      sessionId: typeof event.session_id === "string" ? event.session_id : undefined
    });
  }

  return undefined;
}

function normalizeProviderResult(
  provider: RuntimeKind,
  event: Record<string, unknown>
): NormalizedAgentEvent | undefined {
  if (event.type !== "result") return undefined;
  const message = typeof event.result === "string" ? event.result : undefined;

  if (event.is_error === true) {
    return {
      type: "agent.error",
      visibility: "public",
      payload: {
        provider,
        message: message ?? "Provider reported an error"
      }
    };
  }

  return {
    type: "agent.completed",
    visibility: "public",
    payload: compactRecord({ provider, message })
  };
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
