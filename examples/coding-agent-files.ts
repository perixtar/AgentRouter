import { gunzipSync } from "node:zlib";
import type { Artifact, RunSession } from "@agentrouterhq/sdk";
import { streamAgent } from "@agentrouterhq/sdk";
import {
  codexRuntime,
  handleExampleError,
  hasHelpFlag,
  logRunEvent,
  makeExampleClient
} from "./shared.js";

const marker = "AR_CODING_AGENT_FILES_OK";
const expectedFiles = [
  "src/agentrouter-example.ts",
  "tests/agentrouter-example.test.ts",
  "docs/agentrouter-example.md"
];

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

let client: ReturnType<typeof makeExampleClient>["client"];

try {
  const exampleClient = makeExampleClient();
  const baseUrl = exampleClient.baseUrl;
  client = exampleClient.client;
  const stream = await streamAgent({
    client,
    task: process.env.AGENTROUTER_TASK ?? defaultTask(),
    runtime: codexRuntime("full_access"),
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000
  });

  console.log(`API: ${baseUrl}`);
  console.log(`Run ${stream.run.id}: ${stream.run.status}`);
  console.log("Streaming normalized events:");

  for await (const event of stream.events) {
    logRunEvent(event);
  }

  const result = await stream.finalResult;
  const session = result.session;
  printSession(session);
  console.log(`Agent response: ${result.text || "(no text response)"}`);

  if (session.run.status !== "completed") {
    console.error(`Run ended as ${session.run.status}`);
    if (session.run.failure) console.error(JSON.stringify(session.run.failure, null, 2));
    process.exit(1);
  }

  await verifyWorkspaceArtifacts(session);
} catch (error) {
  handleExampleError(error);
}

function defaultTask(): string {
  return `Use the shell tool to run exactly this command:

mkdir -p src tests docs && cat > src/agentrouter-example.ts <<'EOF'
export function summarizeRun(status: string, artifacts: string[]): string {
  return "run=" + status + "; artifacts=" + artifacts.join(",") + "; marker=${marker}";
}
EOF
cat > tests/agentrouter-example.test.ts <<'EOF'
import { summarizeRun } from "../src/agentrouter-example";

console.log(summarizeRun("completed", ["stdout_log", "workspace_patch"]));
EOF
cat > docs/agentrouter-example.md <<'EOF'
# AgentRouter Coding Agent Files

This file was created inside a Daytona sandbox by Codex.

Marker: ${marker}
EOF

Then reply in one sentence mentioning ${marker}.`;
}

function printSession(session: RunSession): void {
  console.log(`Final status: ${session.run.status}`);
  console.log(`Last event sequence: ${session.eventCursor.lastEventSeq}`);
  console.log(
    `Artifacts: ${session.artifacts.items.map((artifact) => artifact.kind).join(", ") || "(none)"}`
  );
}

async function verifyWorkspaceArtifacts(session: RunSession): Promise<void> {
  const fileIndexArtifact = requireArtifact(session, "workspace_file_index");
  const patchArtifact = requireArtifact(session, "workspace_patch");
  const stdoutArtifact = requireArtifact(session, "stdout_log");

  const fileIndexText = await downloadText(session.run.id, fileIndexArtifact);
  const fileIndex = JSON.parse(fileIndexText) as {
    files?: Array<{ status?: string; path?: string }>;
  };
  const indexedPaths = new Set((fileIndex.files ?? []).map((file) => file.path).filter(isString));

  const missingIndexedFiles = expectedFiles.filter((file) => !indexedPaths.has(file));
  if (missingIndexedFiles.length > 0) {
    throw new Error(`Workspace file index is missing: ${missingIndexedFiles.join(", ")}`);
  }

  const patchText = await downloadText(session.run.id, patchArtifact);
  const missingPatchMarkers = [marker, ...expectedFiles].filter((value) => !patchText.includes(value));
  if (missingPatchMarkers.length > 0) {
    throw new Error(`Workspace patch is missing expected content: ${missingPatchMarkers.join(", ")}`);
  }

  const generatedFiles = extractGeneratedFiles(patchText);
  const generatedPaths = new Set(generatedFiles.map((file) => file.path));
  const missingGeneratedFiles = expectedFiles.filter((file) => !generatedPaths.has(file));
  if (missingGeneratedFiles.length > 0) {
    throw new Error(`Workspace patch did not expose generated files: ${missingGeneratedFiles.join(", ")}`);
  }

  const stdoutText = await downloadText(session.run.id, stdoutArtifact);
  const stdoutPreview = stdoutText.replaceAll("\n", " ").slice(0, 240);

  console.log("Verified workspace artifacts:");
  console.log(`  file index contains ${expectedFiles.length} expected files`);
  console.log(`  patch size: ${formatBytes(Buffer.byteLength(patchText, "utf8"))}`);
  console.log(`  stdout preview: ${stdoutPreview}`);
  console.log("Generated files from workspace_patch:");
  for (const file of generatedFiles.filter((item) => expectedFiles.includes(item.path))) {
    console.log(`--- ${file.path} (${formatBytes(Buffer.byteLength(file.content, "utf8"))}) ---`);
    console.log(file.content.trimEnd());
  }
}

function extractGeneratedFiles(patch: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  let current: { path: string; lines: string[] } | undefined;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git a/")) {
      if (current) files.push({ path: current.path, content: current.lines.join("\n") });
      current = { path: pathFromDiffLine(line), lines: [] };
      inHunk = false;
      continue;
    }

    if (!current) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }

    if (inHunk && line.startsWith("+") && !line.startsWith("+++")) {
      current.lines.push(line.slice(1));
    }
  }

  if (current) files.push({ path: current.path, content: current.lines.join("\n") });
  return files;
}

function pathFromDiffLine(line: string): string {
  const markerText = " b/";
  const splitAt = line.lastIndexOf(markerText);
  if (splitAt === -1) return line.replace(/^diff --git a\//, "");
  return line.slice(splitAt + markerText.length);
}

function requireArtifact(session: RunSession, kind: string): Artifact {
  const artifact = session.artifacts.items.find((item) => item.kind === kind);
  if (!artifact) {
    throw new Error(
      `Expected ${kind} artifact, got: ${session.artifacts.items.map((item) => item.kind).join(", ")}`
    );
  }
  return artifact;
}

async function downloadText(runId: string, artifact: Artifact): Promise<string> {
  if (!client) throw new Error("Example client was not initialized");
  const bytes = Buffer.from(await client.downloadArtifact(runId, artifact.id));
  if (artifact.kind.endsWith("_log")) {
    return gunzipSync(bytes).toString("utf8");
  }
  return bytes.toString("utf8");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function printHelp(): void {
  console.log(`coding agent files example

Runs a coding-agent scenario in Daytona. Codex creates source, test, and docs
files; the example streams progress, restores the final session, downloads R2
artifacts, verifies the workspace file index, and prints every generated file
from the workspace patch.

Prerequisite:
  pnpm dev

Or run the processes separately:
  pnpm api:dev
  pnpm worker:dev

Run:
  pnpm example:coding-agent-files

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
  AGENTROUTER_MODEL=gpt-4o
`);
}
