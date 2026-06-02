import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { extractAgentResponseFromStdout } from "@agentrouter/core";
import {
  buildProviderProcessEnv,
  redactCredentialCanaries,
  scanForCredentialCanaries
} from "@agentrouter/credential-boundary";
import {
  RunRepository,
  isClaudeCodeRunRecord,
  isCodexRunRecord,
  type RunRecord,
  withSearchPath
} from "@agentrouter/db";
import { decrypt } from "@agentrouter/secret-box";
import { buildClaudeCodeLaunchPlan } from "@agentrouter/runtime-claude-code";
import {
  buildCodexLaunchPlan,
  buildCodexSessionLaunchPlan
} from "@agentrouter/runtime-codex-cli";

export interface WorkerSandboxDriver {
  createSandbox(input: {
    name: string;
    env?: Record<string, string>;
    persistent?: boolean;
    autoStopIntervalMinutes?: number;
  }): Promise<{ id: string; name?: string }>;
  executeCommand(
    sandboxId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  deleteSandbox(sandboxId: string): Promise<void>;
  // Optional persistent-session ops (present on the real Daytona driver).
  waitUntilReady?(sandboxId: string): Promise<void>;
  suspendSandbox?(sandboxId: string): Promise<void>;
  resumeSandbox?(sandboxId: string): Promise<void>;
  getSandboxState?(sandboxId: string): Promise<string | undefined>;
}

export interface RunOneWorkerIterationInput {
  pool: Pool;
  schema: string;
  workerId: string;
  sandbox: WorkerSandboxDriver;
  artifactStore: R2ArtifactStore;
  testResourcePrefix: string;
  codexApiKey?: string;
  anthropicApiKey?: string;
  /** Base64 master key for decrypting the org's BYOK provider key (Fly only). */
  masterKey?: string;
  /** Idle minutes before a session's persistent sandbox auto-stops (default 15). */
  sessionAutoStopMinutes?: number;
  baseEnv: NodeJS.ProcessEnv;
}

/** Typed failure so the run is recorded with a clean, surfaced failure code. */
export class RunFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export interface RunOneWorkerIterationResult {
  processed: boolean;
  runId?: string;
}

export interface RunWorkerLoopInput extends RunOneWorkerIterationInput {
  pollIntervalMs?: number;
  signal?: AbortSignal;
  onIteration?: (result: RunOneWorkerIterationResult) => void;
}

const repoDir = "/home/daytona/agentrouter/repo";

export async function runOneWorkerIteration(
  input: RunOneWorkerIterationInput
): Promise<RunOneWorkerIterationResult> {
  const claimed = await withClient(input, async (client) => {
    await client.query("begin");
    try {
      const repo = new RunRepository(client);
      const run = await repo.claimNextRun(input.workerId);
      if (!run) {
        await client.query("commit");
        return undefined;
      }

      await repo.appendEvent({
        runId: run.id,
        source: "worker",
        eventType: "run.claimed",
        visibility: "internal",
        payload: { workerId: input.workerId }
      });
      await client.query("commit");
      return run;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  if (!claimed) {
    return { processed: false };
  }

  await executeClaimedRun(input, claimed);
  return { processed: true, runId: claimed.id };
}

export async function runWorkerLoop(input: RunWorkerLoopInput): Promise<void> {
  const pollIntervalMs = input.pollIntervalMs ?? 1000;

  while (!input.signal?.aborted) {
    const result = await runOneWorkerIteration(input);
    input.onIteration?.(result);

    if (!result.processed) {
      await sleep(pollIntervalMs, input.signal);
    }
  }
}

async function executeClaimedRun(
  input: RunOneWorkerIterationInput,
  run: RunRecord
): Promise<void> {
  // Session runs take the persistent multi-turn path (reuse + suspend).
  // One-shot runs keep the original delete-on-finish path unchanged.
  if (run.sessionId) {
    await executeSessionRun(input, run, run.sessionId);
    return;
  }
  await executeOneShotRun(input, run);
}

async function executeOneShotRun(
  input: RunOneWorkerIterationInput,
  run: RunRecord
): Promise<void> {
  const attemptId = `attempt_${randomUUID()}`;
  const sandboxName = `${input.testResourcePrefix}-${run.id}`;
  let sandboxId: string | undefined;
  let stdout = "";
  let stderr = "";

  try {
    // BYOK resolution: for an org run, the org's provider key (decrypted with
    // the master key) is the ONLY credential used — no silent fallback to the
    // global key. Legacy (org_id null) runs keep using the global key.
    const providerKeyOverride = await resolveOrgProviderKey(input, run);
    const runtime = buildRuntimeLaunch(input, run, providerKeyOverride);

    await withClient(input, async (client) => {
      const repo = new RunRepository(client);
      await repo.createRunAttempt({
        id: attemptId,
        runId: run.id,
        orgId: run.orgId,
        attemptNumber: 1,
        workerId: input.workerId,
        runtimeKind: run.runtimeKind,
        runtimeMode: run.runtimeMode,
        runtimeModel: run.runtimeModel,
        permissionProfile: { ...runtime.launchPlan.permissionProfile },
        credentialStrategy: runtime.credentialBoundary.credentialStrategy
      });
    });

    const sandbox = await input.sandbox.createSandbox({
      name: sandboxName,
      env: runtime.credentialBoundary.generalSandboxEnv
    });
    sandboxId = sandbox.id;

    await withClient(input, async (client) => {
      const repo = new RunRepository(client);
      await repo.recordSandboxSession({
        id: `sandbox_session_${randomUUID()}`,
        runId: run.id,
        runAttemptId: attemptId,
        provider: "daytona",
        externalId: sandbox.id,
        status: "running"
      });
      await repo.appendEvent({
        runId: run.id,
        source: "worker",
        eventType: "sandbox.created",
        visibility: "internal",
        payload: { sandboxId: sandbox.id, provider: "daytona" }
      });
      await repo.updateRunStatus(run.id, "running");
    });

    await requireSuccessfulCommand("workspace_setup", setupScratchWorkspace(input.sandbox, sandbox.id));
    await ensureProviderRuntime(input.sandbox, sandbox.id, runtime.provider);

    const command = shellCommand(runtime.launchPlan.command, runtime.launchPlan.argv);
    const result = await input.sandbox.executeCommand(sandbox.id, command, {
      cwd: repoDir,
      env: providerRuntimeEnv(runtime.launchPlan.env),
      timeoutSeconds: 0
    });
    assertNoCredentialLeaks(
      result.stdout + result.stderr,
      runtime.credentialCanaries,
      "provider output"
    );
    stdout = redactCredentialCanaries(result.stdout, runtime.credentialCanaries);
    stderr = redactCredentialCanaries(result.stderr, runtime.credentialCanaries);

    await appendOutputAndArtifacts(input, run.id, attemptId, runtime.eventSource, stdout, stderr);

    const fileIndex = await collectWorkspaceFileIndex(input.sandbox, sandbox.id);
    assertNoCredentialLeaks(
      JSON.stringify(fileIndex),
      runtime.credentialCanaries,
      "workspace file index"
    );
    await recordWorkspaceFileIndex(input, run.id, attemptId, fileIndex);
    const patch = await collectPatch(input.sandbox, sandbox.id);
    assertNoCredentialLeaks(patch, runtime.credentialCanaries, "workspace patch");
    await recordPatchArtifact(input, run.id, attemptId, patch);

    const failure =
      result.exitCode === 0
        ? undefined
        : {
            code: "provider_runtime_failed",
            reason: providerFailureReason(runtime, result.exitCode, stdout, stderr)
          };
    const terminalSnapshot: TerminalRunSnapshot =
      result.exitCode === 0
        ? {
            status: "completed",
            eventType: "run.completed",
            payload: { message: "completed" }
          }
        : {
            status: "failed",
            eventType: "run.failed",
            payload: { exitCode: result.exitCode, reason: failure?.reason },
            failure
          };

    await recordSessionManifest(input, run.id, attemptId, terminalSnapshot);

    await withClient(input, async (client) => {
      const repo = new RunRepository(client);
      await repo.appendEvent({
        runId: run.id,
        source: "worker",
        eventType: terminalSnapshot.eventType,
        visibility: "public",
        payload: terminalSnapshot.payload
      });
      await repo.updateRunStatus(run.id, terminalSnapshot.status, terminalSnapshot.failure);
    });
  } catch (error) {
    await markRunFailed(input, run.id, error);
  } finally {
    if (sandboxId) {
      await input.sandbox.deleteSandbox(sandboxId);
    }
  }
}

/**
 * Multi-turn SESSION run. The session owns a persistent sandbox:
 * - turn 1: lazily create the persistent sandbox (one git init) + non-ephemeral
 *   Codex (so the session persists); capture the Codex session id (thread_id).
 * - later turns: resume the sandbox, SKIP git-init, `codex exec resume --last`.
 * After the turn the sandbox is SUSPENDED (not deleted) so the fs + Codex
 * session survive for the next message.
 */
async function executeSessionRun(
  input: RunOneWorkerIterationInput,
  run: RunRecord,
  sessionId: string
): Promise<void> {
  const attemptId = `attempt_${randomUUID()}`;
  let sandboxId: string | undefined;
  let suspendInFinally = false;
  // Whether this session already had a persistent sandbox before this turn.
  // Drives the failure-path cleanup so a pre-sandbox failure doesn't wedge the
  // session in 'creating' (OBS 3).
  let hadExistingSandbox = false;

  try {
    if (!isCodexRunRecord(run)) {
      throw new RunFailure("session_runtime_unsupported", "Sessions support the Codex runtime only");
    }

    const session = await withClient(input, async (client) =>
      new RunRepository(client).getSessionInternal(sessionId)
    );
    if (!session) throw new RunFailure("session_not_found", "Session not found for run");
    hadExistingSandbox = Boolean(session.sandboxId) && session.sandboxState !== "none";

    const providerKeyOverride = await resolveOrgProviderKey(input, run);
    const codexKey = providerKeyOverride ?? input.codexApiKey;
    if (!codexKey) throw new Error("Missing Codex provider key for session run");

    const credentialBoundary = buildProviderProcessEnv({
      provider: "codex",
      rawProviderKey: codexKey,
      baseEnv: input.baseEnv
    });
    const canaries = [codexKey];

    const isFirstTurn = !session.sandboxId || session.sandboxState === "none";

    await withClient(input, async (client) => {
      await new RunRepository(client).createRunAttempt({
        id: attemptId,
        runId: run.id,
        orgId: run.orgId,
        attemptNumber: 1,
        workerId: input.workerId,
        runtimeKind: run.runtimeKind,
        runtimeMode: run.runtimeMode,
        runtimeModel: run.runtimeModel,
        permissionProfile: { resume: !isFirstTurn },
        credentialStrategy: credentialBoundary.credentialStrategy
      });
    });

    // ── acquire the sandbox (create on turn 1, resume on later turns) ──
    if (isFirstTurn) {
      const sandbox = await input.sandbox.createSandbox({
        name: `${input.testResourcePrefix}-sess-${sessionId.slice(0, 18)}`,
        env: credentialBoundary.generalSandboxEnv,
        persistent: true,
        autoStopIntervalMinutes: input.sessionAutoStopMinutes ?? 15
      });
      sandboxId = sandbox.id;
      suspendInFinally = true;
      await input.sandbox.waitUntilReady?.(sandbox.id);
      await emitSessionEvent(input, run.id, "sandbox.created", {
        sandboxId: sandbox.id,
        provider: "daytona",
        persistent: true
      });
      await withClient(input, async (client) => {
        const repo = new RunRepository(client);
        await repo.recordSandboxSession({
          id: `sandbox_session_${randomUUID()}`,
          runId: run.id,
          runAttemptId: attemptId,
          provider: "daytona",
          externalId: sandbox.id,
          status: "running"
        });
        await repo.updateSessionSandbox({
          sessionId,
          sandboxId: sandbox.id,
          sandboxState: "running"
        });
      });
      await requireSuccessfulCommand("workspace_setup", setupScratchWorkspace(input.sandbox, sandbox.id));
      await ensureProviderRuntime(input.sandbox, sandbox.id, "codex");
    } else {
      sandboxId = session.sandboxId!;
      await input.sandbox.resumeSandbox?.(sandboxId);
      suspendInFinally = true;
      await input.sandbox.waitUntilReady?.(sandboxId);
      await emitSessionEvent(input, run.id, "sandbox.resumed", { sandboxId });
      await withClient(input, async (client) => {
        await new RunRepository(client).updateSessionSandbox({
          sessionId,
          sandboxState: "running"
        });
      });
    }

    await withClient(input, async (client) => {
      await new RunRepository(client).updateRunStatus(run.id, "running");
    });

    // ── run codex (resume on later turns) ──
    const launchPlan = buildCodexSessionLaunchPlan({
      mode: run.runtimeMode as Parameters<typeof buildCodexSessionLaunchPlan>[0]["mode"],
      model: run.runtimeModel,
      task: taskFromRun(run),
      workdir: repoDir,
      providerEnv: credentialBoundary.providerEnv,
      resume: !isFirstTurn
    });

    const command = shellCommand(launchPlan.command, launchPlan.argv);
    const result = await input.sandbox.executeCommand(sandboxId, command, {
      cwd: repoDir,
      env: providerRuntimeEnv(launchPlan.env),
      timeoutSeconds: 0
    });
    assertNoCredentialLeaks(result.stdout + result.stderr, canaries, "provider output");
    const stdout = redactCredentialCanaries(result.stdout, canaries);
    const stderr = redactCredentialCanaries(result.stderr, canaries);

    // Capture the Codex session id (thread_id) on turn 1 for later resume.
    if (isFirstTurn) {
      const codexSessionId = extractCodexSessionId(stdout);
      if (codexSessionId) {
        await withClient(input, async (client) => {
          await new RunRepository(client).updateSessionSandbox({ sessionId, codexSessionId });
        });
      }
    }

    await appendOutputAndArtifacts(input, run.id, attemptId, "codex", stdout, stderr);

    const fileIndex = await collectWorkspaceFileIndex(input.sandbox, sandboxId);
    assertNoCredentialLeaks(JSON.stringify(fileIndex), canaries, "workspace file index");
    await recordWorkspaceFileIndex(input, run.id, attemptId, fileIndex);
    const patch = await collectPatch(input.sandbox, sandboxId);
    assertNoCredentialLeaks(patch, canaries, "workspace patch");
    await recordPatchArtifact(input, run.id, attemptId, patch);

    const failure =
      result.exitCode === 0
        ? undefined
        : { code: "provider_runtime_failed", reason: truncateFailureDetail(stdout + stderr) };
    const terminalSnapshot: TerminalRunSnapshot =
      result.exitCode === 0
        ? { status: "completed", eventType: "run.completed", payload: { message: "completed" } }
        : {
            status: "failed",
            eventType: "run.failed",
            payload: { exitCode: result.exitCode, reason: failure?.reason },
            failure
          };

    await recordSessionManifest(input, run.id, attemptId, terminalSnapshot);

    await withClient(input, async (client) => {
      const repo = new RunRepository(client);
      await repo.appendEvent({
        runId: run.id,
        source: "worker",
        eventType: terminalSnapshot.eventType,
        visibility: "public",
        payload: terminalSnapshot.payload
      });
      await repo.updateRunStatus(run.id, terminalSnapshot.status, terminalSnapshot.failure);
    });
  } catch (error) {
    await markRunFailed(input, run.id, error);
  } finally {
    if (sandboxId && suspendInFinally) {
      // Suspend (NOT delete) so the fs + Codex session survive for the next turn.
      try {
        await input.sandbox.suspendSandbox?.(sandboxId);
        await withClient(input, async (client) => {
          await new RunRepository(client).updateSessionSandbox({
            sessionId,
            sandboxState: "suspended"
          });
        });
        await emitSessionEvent(input, run.id, "sandbox.suspended", { sandboxId }).catch(() => undefined);
      } catch {
        // best-effort; auto-stop will suspend it anyway
      }
    } else if (!sandboxId && !hadExistingSandbox) {
      // Pre-sandbox failure on a first turn (e.g. byok_missing): beginSessionTurn
      // flipped sandbox_state 'none'→'creating'. Reset to a clean retryable
      // state so the next message can start a fresh turn (OBS 3 + Bug 1c).
      await withClient(input, async (client) => {
        await new RunRepository(client).resetSessionSandbox(sessionId);
      }).catch(() => undefined);
    }
  }
}

async function emitSessionEvent(
  input: RunOneWorkerIterationInput,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>
): Promise<void> {
  await withClient(input, async (client) => {
    await new RunRepository(client).appendEvent({
      runId,
      source: "worker",
      eventType,
      visibility: "internal",
      payload
    });
  });
}

/** Pulls the Codex session id (thread_id) from the JSON stream's first event. */
function extractCodexSessionId(stdout: string): string | undefined {
  for (const line of stdout.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      const j = JSON.parse(s) as Record<string, unknown>;
      const id =
        (typeof j.thread_id === "string" && j.thread_id) ||
        (typeof j.session_id === "string" && j.session_id);
      if (id) return id;
    } catch {
      // ignore non-JSON lines
    }
  }
  return undefined;
}

type RuntimeProvider = "codex" | "claude_code";

interface WorkerLaunchPlan {
  command: "codex" | "claude";
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  permissionProfile: object;
}

interface RuntimeLaunch {
  provider: RuntimeProvider;
  displayName: string;
  eventSource: string;
  credentialBoundary: ReturnType<typeof buildProviderProcessEnv>;
  credentialCanaries: string[];
  launchPlan: WorkerLaunchPlan;
}

interface TerminalRunSnapshot {
  status: "completed" | "failed";
  eventType: "run.completed" | "run.failed";
  payload: Record<string, unknown>;
  failure?: { code: string; reason: string };
}

function providerFailureReason(
  runtime: RuntimeLaunch,
  exitCode: number,
  stdout: string,
  stderr: string
): string {
  const structuredReason = extractStructuredProviderError(stdout);
  const stderrReason = firstNonEmptyLine(stderr);
  const detail = structuredReason ?? stderrReason;
  if (!detail) {
    return `${runtime.displayName} process exited non-zero with exit code ${exitCode}`;
  }

  return `${runtime.displayName} process exited non-zero: ${truncateFailureDetail(detail)}`;
}

function extractStructuredProviderError(output: string): string | undefined {
  for (const line of output.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    const event = parseJsonObject(trimmed);
    if (!event) continue;

    if (event.type === "result" && event.is_error === true && typeof event.result === "string") {
      return event.result;
    }

    if (typeof event.error === "string") {
      const message = extractMessageText(event);
      return message ? `${event.error}: ${message}` : event.error;
    }
  }

  return undefined;
}

function extractMessageText(event: Record<string, unknown>): string | undefined {
  const message = event.message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      return (item as { text: string }).text;
    }
  }

  return undefined;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function firstNonEmptyLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function truncateFailureDetail(detail: string): string {
  const compact = detail.replace(/\s+/g, " ").trim();
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

function buildRuntimeLaunch(
  input: RunOneWorkerIterationInput,
  run: RunRecord,
  providerKeyOverride?: string
): RuntimeLaunch {
  if (isCodexRunRecord(run)) {
    // BYOK override (org run) takes precedence; global key is the legacy fallback.
    const codexKey = providerKeyOverride ?? input.codexApiKey;
    if (!codexKey) {
      throw new Error("Missing CODEX_API_KEY or OPENAI_API_KEY for Codex runtime");
    }

    const credentialBoundary = buildProviderProcessEnv({
      provider: "codex",
      rawProviderKey: codexKey,
      baseEnv: input.baseEnv
    });
    const launchPlan = buildCodexLaunchPlan({
      mode: run.runtimeMode,
      model: run.runtimeModel,
      task: taskFromRun(run),
      workdir: repoDir,
      providerEnv: credentialBoundary.providerEnv,
      reviewBase: undefined
    });

    return {
      provider: "codex",
      displayName: "Codex",
      eventSource: "codex",
      credentialBoundary,
      credentialCanaries: [codexKey],
      launchPlan
    };
  }

  if (isClaudeCodeRunRecord(run)) {
    const anthropicKey = providerKeyOverride ?? input.anthropicApiKey;
    if (!anthropicKey) {
      throw new Error("Missing ANTHROPIC_API_KEY for Claude Code runtime");
    }

    const credentialBoundary = buildProviderProcessEnv({
      provider: "claude_code",
      rawProviderKey: anthropicKey,
      baseEnv: input.baseEnv
    });
    const launchPlan = buildClaudeCodeLaunchPlan({
      permissionMode: run.runtimeMode,
      model: run.runtimeModel,
      task: taskFromRun(run),
      workdir: repoDir,
      providerEnv: credentialBoundary.providerEnv
    });

    return {
      provider: "claude_code",
      displayName: "Claude Code",
      eventSource: "claude_code",
      credentialBoundary,
      credentialCanaries: [anthropicKey],
      launchPlan
    };
  }

  throw new Error(`Unsupported runtime kind: ${run.runtimeKind}`);
}

async function setupScratchWorkspace(
  sandbox: WorkerSandboxDriver,
  sandboxId: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return sandbox.executeCommand(
    sandboxId,
    [
      `rm -rf ${shellQuote(repoDir)}`,
      `mkdir -p ${shellQuote(repoDir)}`,
      `cd ${shellQuote(repoDir)}`,
      "git init",
      "git config user.email agentrouter@example.com",
      "git config user.name AgentRouter",
      "printf '# AgentRouter scratch repo\\n' > README.md",
      "git add README.md",
      "git commit -m initial"
    ].join(" && "),
    { timeoutSeconds: 0 }
  );
}

async function ensureCodex(sandbox: WorkerSandboxDriver, sandboxId: string): Promise<void> {
  const result = await sandbox.executeCommand(
    sandboxId,
    [
      "mkdir -p /home/daytona/.agentrouter-codex",
      "if [ ! -x /usr/bin/zsh ]; then sudo ln -sf /bin/sh /usr/bin/zsh 2>/dev/null || ln -sf /bin/sh /usr/bin/zsh 2>/dev/null || true; fi",
      // Pin to a known resume-capable version (verified in the M4 spike).
      "command -v codex >/dev/null 2>&1 || npm install -g @openai/codex@0.128.0"
    ].join(" && "),
    { timeoutSeconds: 0 }
  );
  if (result.exitCode !== 0) {
    throw new Error(`codex_bootstrap failed: ${result.stdout}${result.stderr}`);
  }
}

async function ensureClaudeCode(sandbox: WorkerSandboxDriver, sandboxId: string): Promise<void> {
  const result = await sandbox.executeCommand(
    sandboxId,
    [
      "CLAUDE_PREFIX=/home/daytona/.agentrouter-claude/npm-global",
      "mkdir -p \"$CLAUDE_PREFIX\"",
      "export NPM_CONFIG_PREFIX=\"$CLAUDE_PREFIX\"",
      "export PATH=\"$CLAUDE_PREFIX/bin:$PATH\"",
      "if [ ! -x \"$CLAUDE_PREFIX/bin/claude\" ] || ! \"$CLAUDE_PREFIX/bin/claude\" --help 2>&1 | grep -q -- '--bare'; then npm install -g @anthropic-ai/claude-code@latest; fi"
    ].join(" && "),
    { timeoutSeconds: 0 }
  );
  if (result.exitCode !== 0) {
    throw new Error(`claude_bootstrap failed: ${result.stdout}${result.stderr}`);
  }
}

async function ensureProviderRuntime(
  sandbox: WorkerSandboxDriver,
  sandboxId: string,
  provider: RuntimeProvider
): Promise<void> {
  if (provider === "claude_code") {
    await ensureClaudeCode(sandbox, sandboxId);
    return;
  }

  await ensureCodex(sandbox, sandboxId);
}

async function requireSuccessfulCommand(
  step: string,
  commandResultPromise: Promise<{ exitCode: number; stdout: string; stderr: string }>
): Promise<void> {
  const result = await commandResultPromise;
  if (result.exitCode !== 0) {
    throw new Error(`${step} failed: ${result.stdout}${result.stderr}`);
  }
}

async function appendOutputAndArtifacts(
  input: RunOneWorkerIterationInput,
  runId: string,
  attemptId: string,
  providerSource: string,
  stdout: string,
  stderr: string
): Promise<void> {
  const stdoutArtifact = await input.artifactStore.putLogChunk({
    runId,
    stream: "stdout",
    chunkNumber: 1,
    body: Buffer.from(stdout, "utf8"),
    eventSequenceStart: 1n,
    eventSequenceEnd: 1n,
    redactionStatus: "redacted"
  });
  const stderrArtifact = await input.artifactStore.putLogChunk({
    runId,
    stream: "stderr",
    chunkNumber: 1,
    body: Buffer.from(stderr, "utf8"),
    eventSequenceStart: 1n,
    eventSequenceEnd: 1n,
    redactionStatus: "redacted"
  });

  await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    const stdoutRecord = await repo.recordArtifact({
      id: `artifact_${randomUUID()}`,
      runId,
      runAttemptId: attemptId,
      kind: "stdout_log",
      r2Key: stdoutArtifact.r2Key,
      contentType: stdoutArtifact.contentType,
      sizeBytes: stdoutArtifact.compressedSizeBytes,
      sha256: stdoutArtifact.sha256,
      metadata: stdoutArtifact.metadata
    });
    const stderrRecord = await repo.recordArtifact({
      id: `artifact_${randomUUID()}`,
      runId,
      runAttemptId: attemptId,
      kind: "stderr_log",
      r2Key: stderrArtifact.r2Key,
      contentType: stderrArtifact.contentType,
      sizeBytes: stderrArtifact.compressedSizeBytes,
      sha256: stderrArtifact.sha256,
      metadata: stderrArtifact.metadata
    });
    await repo.appendEvent({
      runId,
      source: providerSource,
      eventType: "provider.stdout",
      visibility: "public",
      payload: { text: stdout },
      artifactRef: { artifactId: stdoutRecord.id, r2Key: stdoutRecord.r2Key }
    });
    await repo.appendEvent({
      runId,
      source: providerSource,
      eventType: "provider.stderr",
      visibility: "internal",
      payload: { text: stderr },
      artifactRef: { artifactId: stderrRecord.id, r2Key: stderrRecord.r2Key }
    });

    const response = extractAgentResponseFromStdout(stdout);
    if (response) {
      await repo.appendEvent({
        runId,
        source: providerSource,
        eventType: "agent.response",
        visibility: "public",
        payload: { ...response, provider: providerSource }
      });
    }
  });
}

async function collectPatch(sandbox: WorkerSandboxDriver, sandboxId: string): Promise<string> {
  const result = await sandbox.executeCommand(
    sandboxId,
    "git add -N . >/dev/null 2>&1 || true; git diff --binary HEAD || true",
    { cwd: repoDir, timeoutSeconds: 0 }
  );
  return result.stdout;
}

async function collectWorkspaceFileIndex(
  sandbox: WorkerSandboxDriver,
  sandboxId: string
): Promise<Array<{ status: string; path: string }>> {
  const result = await sandbox.executeCommand(
    sandboxId,
    "git status --porcelain=v1 -z --untracked-files=all",
    { cwd: repoDir, timeoutSeconds: 0 }
  );

  return result.stdout
    .split("\0")
    .map((entry) => entry.trimEnd())
    .filter((entry) => entry.length > 0)
    .map((entry) => ({
      status: entry.slice(0, 2),
      path: entry.slice(3)
    }));
}

async function recordWorkspaceFileIndex(
  input: RunOneWorkerIterationInput,
  runId: string,
  attemptId: string,
  fileIndex: Array<{ status: string; path: string }>
): Promise<void> {
  const stored = await input.artifactStore.putArtifact({
    runId,
    path: "workspace/file-index.json",
    body: Buffer.from(JSON.stringify({ files: fileIndex }, null, 2), "utf8"),
    contentType: "application/json"
  });

  await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    const artifact = await repo.recordArtifact({
      id: `artifact_${randomUUID()}`,
      runId,
      runAttemptId: attemptId,
      kind: "workspace_file_index",
      r2Key: stored.r2Key,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      metadata: {
        ...stored.metadata,
        fileCount: fileIndex.length
      }
    });
    await repo.appendEvent({
      runId,
      source: "worker",
      eventType: "workspace.file_index_collected",
      visibility: "public",
      payload: { fileCount: fileIndex.length },
      artifactRef: { artifactId: artifact.id, r2Key: artifact.r2Key }
    });
  });
}

async function recordPatchArtifact(
  input: RunOneWorkerIterationInput,
  runId: string,
  attemptId: string,
  patch: string
): Promise<void> {
  const stored = await input.artifactStore.putArtifact({
    runId,
    path: "workspace/changes.patch",
    body: Buffer.from(patch, "utf8"),
    contentType: "text/x-patch"
  });

  await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    const artifact = await repo.recordArtifact({
      id: `artifact_${randomUUID()}`,
      runId,
      runAttemptId: attemptId,
      kind: "workspace_patch",
      r2Key: stored.r2Key,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      metadata: stored.metadata
    });
    await repo.appendEvent({
      runId,
      source: "worker",
      eventType: "workspace.patch_collected",
      visibility: "public",
      payload: { bytes: stored.sizeBytes },
      artifactRef: { artifactId: artifact.id, r2Key: artifact.r2Key }
    });
  });
}

async function recordSessionManifest(
  input: RunOneWorkerIterationInput,
  runId: string,
  attemptId: string,
  terminalSnapshot: TerminalRunSnapshot
): Promise<void> {
  const manifest = await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    const run = await repo.getRunInternal(runId);
    const events = await repo.listEventsInternal({ runId, limit: 500 });
    const artifacts = await repo.listArtifactsInternal(runId);
    const lastEventSeq = events.at(-1)?.sequence ?? run?.lastEventSeq ?? 0n;
    return {
      run: {
        id: run?.id,
        status: terminalSnapshot.status,
        runtimeKind: run?.runtimeKind,
        runtimeMode: run?.runtimeMode,
        runtimeModel: run?.runtimeModel,
        lastEventSeq: Number(lastEventSeq + 1n),
        failure: terminalSnapshot.failure
      },
      events: [
        ...events.map((event) => ({
          sequence: Number(event.sequence),
          type: event.eventType,
          artifactRef: event.artifactRef
        })),
        {
          sequence: Number(lastEventSeq + 1n),
          type: terminalSnapshot.eventType
        }
      ],
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        kind: artifact.kind,
        r2Key: artifact.r2Key,
        sha256: artifact.sha256,
        sizeBytes: Number(artifact.sizeBytes)
      }))
    };
  });

  const stored = await input.artifactStore.putArtifact({
    runId,
    path: "session/manifest.json",
    body: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    contentType: "application/json"
  });

  await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    await repo.recordArtifact({
      id: `artifact_${randomUUID()}`,
      runId,
      runAttemptId: attemptId,
      kind: "session_manifest",
      r2Key: stored.r2Key,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      metadata: stored.metadata
    });
  });
}

async function markRunFailed(
  input: RunOneWorkerIterationInput,
  runId: string,
  error: unknown
): Promise<void> {
  const code = error instanceof RunFailure ? error.code : "worker_failed";
  const reason = error instanceof Error ? error.message : "Unknown worker failure";
  await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    await repo.appendEvent({
      runId,
      source: "worker",
      eventType: "run.failed",
      visibility: "public",
      payload: { code, reason }
    });
    const run = await repo.getRunInternal(runId);
    if (run && !["completed", "failed", "cancelled"].includes(run.status)) {
      if (run.status === "queued") await repo.updateRunStatus(runId, "starting");
      if (run.status === "starting") await repo.updateRunStatus(runId, "running");
      await repo.updateRunStatus(runId, "failed", { code, reason });
    }
  });
}

/**
 * Resolves the raw provider key for a run.
 * - org run (org_id set): decrypt the org's provider_keys row → that key only.
 *   No key → RunFailure("byok_missing").
 * - legacy run (org_id null): undefined → buildRuntimeLaunch uses the global key.
 */
async function resolveOrgProviderKey(
  input: RunOneWorkerIterationInput,
  run: RunRecord
): Promise<string | undefined> {
  if (!run.orgId) return undefined;

  // BYOK currently covers OpenAI/Codex. Claude Code BYOK is a later phase; for
  // now only resolve for codex runs (claude_code org runs fall through to the
  // global key path in buildRuntimeLaunch).
  if (!isCodexRunRecord(run)) return undefined;

  const provider = "openai";
  const encrypted = await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    return repo.getProviderKey(run.orgId!, provider);
  });

  if (!encrypted) {
    throw new RunFailure(
      "byok_missing",
      "No provider key connected for this org. Connect your OpenAI key."
    );
  }

  const masterKey = input.masterKey ?? process.env.AGENTROUTER_MASTER_KEY;
  if (!masterKey) {
    throw new RunFailure(
      "byok_unconfigured",
      "Provider key decryption is not configured (missing master key)"
    );
  }

  return decrypt(
    { ciphertext: encrypted.ciphertext, iv: encrypted.iv, tag: encrypted.tag, keyVersion: encrypted.keyVersion },
    masterKey
  );
}

async function withClient<T>(
  input: RunOneWorkerIterationInput,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await input.pool.connect();
  try {
    return await withSearchPath(client, input.schema, () => fn(client));
  } finally {
    client.release();
  }
}

function taskFromRun(run: RunRecord): string {
  const task = run.input.task;
  return typeof task === "string" ? task : run.promptSummary;
}

function shellCommand(command: string, argv: string[]): string {
  return [command, ...argv].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertNoCredentialLeaks(output: string, secrets: string[], surface: string): void {
  const leaked = scanForCredentialCanaries(output, secrets);
  if (leaked.length > 0) {
    throw new Error(`Credential canary leaked through ${surface}`);
  }
}

function providerRuntimeEnv(providerEnv: Record<string, string>): Record<string, string> {
  return {
    PATH: "/home/daytona/.agentrouter-claude/npm-global/bin:/usr/local/share/nvm/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    SHELL: "/bin/sh",
    HOME: "/home/daytona",
    CODEX_HOME: "/home/daytona/.agentrouter-codex",
    CLAUDE_CONFIG_DIR: "/home/daytona/.agentrouter-claude",
    ...providerEnv
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}
