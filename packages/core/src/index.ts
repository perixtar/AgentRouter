export type RuntimeKind = "codex" | "claude_code";
export type RuntimeMode = "default" | "read_only" | "full_access" | "auto_review";

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
