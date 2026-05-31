import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { buildProviderProcessEnv, scanForCredentialCanaries } from "@agentrouter/credential-boundary";
import {
  RunRepository,
  type RunRecord,
  withSearchPath
} from "@agentrouter/db";
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
  codexApiKey: string;
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
  const credentialBoundary = buildProviderProcessEnv({
    provider: "codex",
    rawProviderKey: input.codexApiKey,
    baseEnv: input.baseEnv
  });
  const attemptId = `attempt_${randomUUID()}`;
  const sandboxName = `${input.testResourcePrefix}-${run.id}`;
  let sandboxId: string | undefined;
  let stdout = "";
  let stderr = "";

  try {
    const launchPlan = buildCodexLaunchPlan({
      mode: run.runtimeMode,
      task: taskFromRun(run),
      workdir: repoDir,
      providerEnv: credentialBoundary.providerEnv,
      reviewBase: reviewBaseFromRun(run)
    });

    await withClient(input, async (client) => {
      const repo = new RunRepository(client);
      await repo.createRunAttempt({
        id: attemptId,
        runId: run.id,
        attemptNumber: 1,
        workerId: input.workerId,
        runtimeKind: run.runtimeKind,
        runtimeMode: run.runtimeMode,
        permissionProfile: { ...launchPlan.permissionProfile },
        credentialStrategy: credentialBoundary.credentialStrategy
      });
    });

    const sandbox = await input.sandbox.createSandbox({
      name: sandboxName,
      env: credentialBoundary.generalSandboxEnv
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

    await requireSuccessfulCommand("source_setup", setupSource(input.sandbox, sandbox.id, run));
    await ensureCodex(input.sandbox, sandbox.id);

    const command = shellCommand(launchPlan.command, launchPlan.argv);
    const result = await input.sandbox.executeCommand(sandbox.id, command, {
      cwd: repoDir,
      env: providerRuntimeEnv(launchPlan.env),
      timeoutSeconds: 0
    });
    stdout = redactSecrets(result.stdout, [input.codexApiKey]);
    stderr = redactSecrets(result.stderr, [input.codexApiKey]);
    assertNoCredentialLeaks(stdout + stderr, [input.codexApiKey]);

    await appendOutputAndArtifacts(input, run.id, attemptId, stdout, stderr);

    const fileIndex = await collectWorkspaceFileIndex(input.sandbox, sandbox.id);
    await recordWorkspaceFileIndex(input, run.id, attemptId, fileIndex);
    const patch = await collectPatch(input.sandbox, sandbox.id);
    await recordPatchArtifact(input, run.id, attemptId, patch);
    await recordSessionManifest(input, run.id, attemptId);

    await withClient(input, async (client) => {
      const repo = new RunRepository(client);
      await repo.appendEvent({
        runId: run.id,
        source: "worker",
        eventType: result.exitCode === 0 ? "run.completed" : "run.failed",
        visibility: "public",
        payload: result.exitCode === 0 ? { message: "completed" } : { exitCode: result.exitCode }
      });
      await repo.updateRunStatus(
        run.id,
        result.exitCode === 0 ? "completed" : "failed",
        result.exitCode === 0
          ? undefined
          : { code: "provider_runtime_failed", reason: "Codex process exited non-zero" }
      );
    });
  } catch (error) {
    await markRunFailed(input, run.id, error);
  } finally {
    if (sandboxId) {
      await input.sandbox.deleteSandbox(sandboxId);
    }
  }
}

async function setupSource(
  sandbox: WorkerSandboxDriver,
  sandboxId: string,
  run: RunRecord
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const source = sourceFromRun(run);
  if (source.type === "git" && source.repoUrl) {
    const branch = source.branch ? ["--branch", source.branch].map(shellQuote).join(" ") : "";
    return sandbox.executeCommand(
      sandboxId,
      `rm -rf ${shellQuote(repoDir)} && git clone --depth 1 ${branch} ${shellQuote(source.repoUrl)} ${shellQuote(repoDir)}`,
      { timeoutSeconds: 0 }
    );
  }

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
      source: "codex",
      eventType: "provider.stdout",
      visibility: "public",
      payload: { text: stdout },
      artifactRef: { artifactId: stdoutRecord.id, r2Key: stdoutRecord.r2Key }
    });
    await repo.appendEvent({
      runId,
      source: "codex",
      eventType: "provider.stderr",
      visibility: "internal",
      payload: { text: stderr },
      artifactRef: { artifactId: stderrRecord.id, r2Key: stderrRecord.r2Key }
    });
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
    "git status --porcelain=v1 -z",
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
  attemptId: string
): Promise<void> {
  const manifest = await withClient(input, async (client) => {
    const repo = new RunRepository(client);
    const run = await repo.getRun(runId);
    const events = await repo.listEvents({ runId, limit: 500 });
    const artifacts = await repo.listArtifacts(runId);
    return {
      run: {
        id: run?.id,
        status: run?.status,
        runtimeKind: run?.runtimeKind,
        runtimeMode: run?.runtimeMode,
        lastEventSeq: run ? Number(run.lastEventSeq) : 0
      },
      events: events.map((event) => ({
        sequence: Number(event.sequence),
        type: event.eventType,
        artifactRef: event.artifactRef
      })),
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

function sourceFromRun(run: RunRecord): {
  type: "git" | "scratch";
  repoUrl?: string;
  branch?: string;
} {
  const source = run.input.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    return {
      type: record.type === "git" ? "git" : "scratch",
      repoUrl: typeof record.repoUrl === "string" ? record.repoUrl : undefined,
      branch: typeof record.branch === "string" ? record.branch : undefined
    };
  }

  return { type: "scratch" };
}

function reviewBaseFromRun(run: RunRecord): string | undefined {
  const source = run.input.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const baseRef = (source as Record<string, unknown>).baseRef;
    return typeof baseRef === "string" ? baseRef : undefined;
  }

  return undefined;
}

function shellCommand(command: string, argv: string[]): string {
  return [command, ...argv].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce((output, secret) => output.replaceAll(secret, "[REDACTED]"), value);
}

function assertNoCredentialLeaks(output: string, secrets: string[]): void {
  const leaked = scanForCredentialCanaries(output, secrets);
  if (leaked.length > 0) {
    throw new Error("Credential canary leaked through provider output");
  }
}

function providerRuntimeEnv(providerEnv: Record<string, string>): Record<string, string> {
  return {
    PATH: "/usr/local/share/nvm/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    SHELL: "/bin/sh",
    HOME: "/home/daytona",
    CODEX_HOME: "/home/daytona/.agentrouter-codex",
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
