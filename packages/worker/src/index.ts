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
import { buildClaudeCodeLaunchPlan } from "@agentrouter/runtime-claude-code";
import { buildCodexLaunchPlan } from "@agentrouter/runtime-codex-cli";

export interface WorkerSandboxDriver {
  createSandbox(input: {
    name: string;
    env?: Record<string, string>;
  }): Promise<{ id: string; name?: string }>;
  executeCommand(
    sandboxId: string,
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutSeconds?: number }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  deleteSandbox(sandboxId: string): Promise<void>;
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
  baseEnv: NodeJS.ProcessEnv;
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
  const attemptId = `attempt_${randomUUID()}`;
  const sandboxName = `${input.testResourcePrefix}-${run.id}`;
  let sandboxId: string | undefined;
  let stdout = "";
  let stderr = "";

  try {
    const runtime = buildRuntimeLaunch(input, run);

    await withClient(input, async (client) => {
      const repo = new RunRepository(client);
      await repo.createRunAttempt({
        id: attemptId,
        runId: run.id,
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
  run: RunRecord
): RuntimeLaunch {
  if (isCodexRunRecord(run)) {
    if (!input.codexApiKey) {
      throw new Error("Missing CODEX_API_KEY or OPENAI_API_KEY for Codex runtime");
    }

    const credentialBoundary = buildProviderProcessEnv({
      provider: "codex",
      rawProviderKey: input.codexApiKey,
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
      credentialCanaries: [input.codexApiKey],
      launchPlan
    };
  }

  if (isClaudeCodeRunRecord(run)) {
    if (!input.anthropicApiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY for Claude Code runtime");
    }

    const credentialBoundary = buildProviderProcessEnv({
      provider: "claude_code",
      rawProviderKey: input.anthropicApiKey,
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
      credentialCanaries: [input.anthropicApiKey],
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
      "command -v codex >/dev/null 2>&1 || npm install -g @openai/codex"
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
    const run = await repo.getRun(runId);
    const events = await repo.listEvents({ runId, limit: 500 });
    const artifacts = await repo.listArtifacts(runId);
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
  const reason = error instanceof Error ? error.message : "Unknown worker failure";
  await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    await repo.appendEvent({
      runId,
      source: "worker",
      eventType: "run.failed",
      visibility: "public",
      payload: { code: "worker_failed", reason }
    });
    const run = await repo.getRun(runId);
    if (run && !["completed", "failed", "cancelled"].includes(run.status)) {
      if (run.status === "queued") await repo.updateRunStatus(runId, "starting");
      if (run.status === "starting") await repo.updateRunStatus(runId, "running");
      await repo.updateRunStatus(runId, "failed", { code: "worker_failed", reason });
    }
  });
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
