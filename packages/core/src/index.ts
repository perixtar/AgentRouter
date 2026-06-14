import { createHash } from "node:crypto";

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

export type ActionKind = "runtime_command" | "command" | "file_write" | "tool_call" | "network_request";
export type ControlPlaneEventActor = "agent" | "policy" | "human" | "runtime" | "system";
export type ActionPolicyDecision = "allowed" | "requires_approval" | "blocked";
export type ActionApprovalDecision = "approved" | "denied";
export type ActionApprovalMode = "auto" | "manual" | "block";

export interface ControlPlaneAction {
  type: ActionKind;
  name: string;
  target?: string;
  args: Record<string, unknown>;
  schemaVersion: string;
}

export interface CanonicalActionBinding {
  action: ControlPlaneAction;
  actionDigest: string;
  argsDigest: string;
}

export function bindCanonicalAction(action: ControlPlaneAction): CanonicalActionBinding {
  const normalizedAction = sortJson(action) as ControlPlaneAction;
  return {
    action: normalizedAction,
    actionDigest: `sha256:${hashStableJson(normalizedAction)}`,
    argsDigest: `sha256:${hashStableJson(normalizedAction.args)}`
  };
}

function hashStableJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  );
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
  | "agent.no_progress"
  | "agent.completed"
  | "agent.error";

export interface NormalizedAgentEvent {
  type: NormalizedAgentEventType;
  visibility: "public";
  providerEventType?: string;
  payload: Record<string, unknown>;
}

export interface NormalizedAgentEventExtractor {
  appendLine(line: string): NormalizedAgentEvent[];
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
  const extractor = createNormalizedAgentEventExtractor(provider);
  const events: NormalizedAgentEvent[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    events.push(...extractor.appendLine(line));
  }

  return events;
}

export function createNormalizedAgentEventExtractor(
  provider: RuntimeKind
): NormalizedAgentEventExtractor {
  let sawStarted = false;
  const noProgress = createNoProgressDetector(provider);

  return {
    appendLine(line: string): NormalizedAgentEvent[] {
      const events: NormalizedAgentEvent[] = [];
      const event = parseJsonLine(line);
      if (!event) {
        events.push(...noProgress.observeUnstructuredLine(line));
        return events;
      }

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

      events.push(...noProgress.observeProviderEvent(event, providerEventType));

      const resultEvent = normalizeProviderResult(provider, event);
      if (resultEvent) {
        events.push({
          ...resultEvent,
          providerEventType
        });
      }

      if (events.length > 0) noProgress.markStateTransition();
      return events;
    }
  };
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

type NoProgressSignal = "repeated_command" | "repeated_edit" | "long_output_without_state";

interface NoProgressObservation {
  signal: NoProgressSignal;
  key: string;
  providerEventType?: string;
  payload: Record<string, unknown>;
}

interface NoProgressCounter {
  occurrences: number;
  emitted: boolean;
  payload: Record<string, unknown>;
  providerEventType?: string;
}

const NO_PROGRESS_REPEAT_THRESHOLD = 3;
const NO_PROGRESS_UNSTRUCTURED_LINE_THRESHOLD = 50;

function createNoProgressDetector(provider: RuntimeKind): {
  observeProviderEvent(
    event: Record<string, unknown>,
    providerEventType?: string
  ): NormalizedAgentEvent[];
  observeUnstructuredLine(line: string): NormalizedAgentEvent[];
  markStateTransition(): void;
} {
  const counters = new Map<string, NoProgressCounter>();
  let unstructuredLinesWithoutState = 0;
  let emittedLongOutput = false;

  function observeObservation(observation: NoProgressObservation): NormalizedAgentEvent[] {
    const existing = counters.get(observation.key);
    const counter =
      existing ??
      ({
        occurrences: 0,
        emitted: false,
        payload: observation.payload,
        providerEventType: observation.providerEventType
      } satisfies NoProgressCounter);
    counter.occurrences += 1;
    counter.payload = observation.payload;
    counter.providerEventType = observation.providerEventType;
    counters.set(observation.key, counter);

    if (counter.emitted || counter.occurrences < NO_PROGRESS_REPEAT_THRESHOLD) return [];
    counter.emitted = true;

    return [
      {
        type: "agent.no_progress",
        visibility: "public",
        providerEventType: counter.providerEventType,
        payload: compactRecord({
          ...counter.payload,
          provider,
          signal: observation.signal,
          occurrences: counter.occurrences
        })
      }
    ];
  }

  return {
    observeProviderEvent(event, providerEventType) {
      unstructuredLinesWithoutState = 0;
      emittedLongOutput = false;
      const observations = [
        extractCommandObservation(provider, event, providerEventType),
        extractEditObservation(provider, event, providerEventType)
      ].filter((item): item is NoProgressObservation => item !== undefined);
      return observations.flatMap(observeObservation);
    },
    observeUnstructuredLine(line) {
      if (!line.trim()) return [];
      unstructuredLinesWithoutState += 1;
      if (
        emittedLongOutput ||
        unstructuredLinesWithoutState < NO_PROGRESS_UNSTRUCTURED_LINE_THRESHOLD
      ) {
        return [];
      }
      emittedLongOutput = true;
      return [
        {
          type: "agent.no_progress",
          visibility: "public",
          payload: {
            provider,
            signal: "long_output_without_state",
            reason: "Long provider output period without normalized run progress",
            outputLines: unstructuredLinesWithoutState
          }
        }
      ];
    },
    markStateTransition() {
      unstructuredLinesWithoutState = 0;
      emittedLongOutput = false;
    }
  };
}

function extractCommandObservation(
  provider: RuntimeKind,
  event: Record<string, unknown>,
  providerEventType?: string
): NoProgressObservation | undefined {
  const commandPayload = findCommandPayload(event);
  if (!commandPayload) return undefined;

  const command = firstString(commandPayload.command, commandPayload.cmd);
  if (!command) return undefined;

  const exitCode = firstNumber(
    commandPayload.exitCode,
    commandPayload.exit_code,
    commandPayload.code
  );
  const output = [
    firstString(commandPayload.stdout),
    firstString(commandPayload.stderr),
    firstString(commandPayload.output),
    firstString(commandPayload.result)
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n");
  const outputDigest = `sha256:${hashStableJson(compactRecord({ exitCode, output }))}`;
  const failed = exitCode === undefined ? Boolean(output) : exitCode !== 0;

  return {
    signal: "repeated_command",
    key: `command:${provider}:${command}:${exitCode ?? "unknown"}:${outputDigest}`,
    providerEventType,
    payload: compactRecord({
      provider,
      signal: "repeated_command",
      reason: failed
        ? "Repeated command failed with similar output"
        : "Repeated command execution without visible progress",
      command,
      exitCode,
      outputDigest
    })
  };
}

function extractEditObservation(
  provider: RuntimeKind,
  event: Record<string, unknown>,
  providerEventType?: string
): NoProgressObservation | undefined {
  const editPayload = findEditPayload(event);
  if (!editPayload) return undefined;

  const path = firstString(
    editPayload.path,
    editPayload.file_path,
    editPayload.filePath,
    editPayload.filename
  );
  if (!path) return undefined;

  const digestInput = compactRecord({
    path,
    oldString: firstString(editPayload.old_string, editPayload.oldString),
    newString: firstString(editPayload.new_string, editPayload.newString),
    content: firstString(editPayload.content),
    diff: firstString(editPayload.diff),
    patch: firstString(editPayload.patch),
    edits: Array.isArray(editPayload.edits) ? editPayload.edits : undefined
  });
  const editDigest = `sha256:${hashStableJson(digestInput)}`;

  return {
    signal: "repeated_edit",
    key: `edit:${provider}:${path}:${editDigest}`,
    providerEventType,
    payload: {
      provider,
      signal: "repeated_edit",
      reason: "Repeated file edit did not produce meaningful progress",
      path,
      editDigest
    }
  };
}

function findCommandPayload(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = commandPayloadFromRecord(event);
  if (direct) return direct;

  const item = objectRecord(event.item);
  if (item) {
    const fromItem = commandPayloadFromRecord(item);
    if (fromItem) return fromItem;
  }

  const content = messageContent(event);
  for (const part of content) {
    const partRecord = objectRecord(part);
    if (!partRecord) continue;
    const fromPart = commandPayloadFromRecord(partRecord);
    if (fromPart) return fromPart;
  }

  return undefined;
}

function findEditPayload(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = editPayloadFromRecord(event);
  if (direct) return direct;

  const item = objectRecord(event.item);
  if (item) {
    const fromItem = editPayloadFromRecord(item);
    if (fromItem) return fromItem;
  }

  const content = messageContent(event);
  for (const part of content) {
    const partRecord = objectRecord(part);
    if (!partRecord) continue;
    const fromPart = editPayloadFromRecord(partRecord);
    if (fromPart) return fromPart;
  }

  return undefined;
}

function commandPayloadFromRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const toolName = firstString(record.name, record.tool, record.tool_name, record.type);
  const input = objectRecord(record.input) ?? objectRecord(record.args);
  const candidate = input ?? record;
  const command = firstString(candidate.command, candidate.cmd);
  if (!command) return undefined;

  if (
    !toolName ||
    /bash|shell|command|exec|terminal|run/i.test(toolName) ||
    firstString(record.type) === "command_execution"
  ) {
    return candidate;
  }

  return undefined;
}

function editPayloadFromRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const toolName = firstString(record.name, record.tool, record.tool_name, record.type);
  const input = objectRecord(record.input) ?? objectRecord(record.args);
  const candidate = input ?? record;
  const path = firstString(candidate.path, candidate.file_path, candidate.filePath, candidate.filename);
  if (!path) return undefined;

  if (!toolName || /edit|write|patch|replace|multiedit|file_change|file_edit/i.test(toolName)) {
    return candidate;
  }

  return undefined;
}

function messageContent(event: Record<string, unknown>): unknown[] {
  const message = objectRecord(event.message);
  const content = message?.content ?? event.content;
  return Array.isArray(content) ? content : [];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
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
