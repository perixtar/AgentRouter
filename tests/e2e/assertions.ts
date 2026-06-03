import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect } from "vitest";
import type { AgentRouterClient, Artifact, RunEvent, RunSession } from "@agentrouterhq/sdk";

const defaultRequiredEventTypes = [
  "run.claimed",
  "sandbox.created",
  "credential_boundary.verified",
  "provider.stdout",
  "provider.stderr",
  "agent.response",
  "workspace.file_index_collected",
  "workspace.patch_collected",
  "run.completed"
];

const expectedArtifactKinds = [
  "session_manifest",
  "session_events",
  "stderr_log",
  "stdout_log",
  "workspace_file_index",
  "workspace_patch"
];

export interface SuccessfulE2ERunExpectation {
  client: AgentRouterClient;
  session: RunSession;
  events: RunEvent[];
  providerSource: "codex" | "claude_code";
  runtimeKind: "codex" | "claude_code";
  marker: string;
  createdPath: string;
  secretCanaries?: Array<string | undefined>;
  requiredEventTypes?: string[];
  sandboxLifecycleEventType?: "sandbox.created" | "sandbox.resumed";
}

export async function assertSuccessfulE2ERun(
  expectation: SuccessfulE2ERunExpectation
): Promise<void> {
  const { client, session, events, providerSource, runtimeKind, marker, createdPath } = expectation;
  const requiredEventTypes = expectation.requiredEventTypes ?? defaultRequiredEventTypes;
  const sandboxLifecycleEventType = expectation.sandboxLifecycleEventType ?? "sandbox.created";
  const runId = session.run.id;

  if (session.run.status !== "completed") {
    throw new Error(
      `Expected ${runtimeKind} run to complete, got ${session.run.status}: ${
        session.run.failure?.reason ?? "no failure reason recorded"
      }`
    );
  }

  expect(session.run.runtime.kind).toBe(runtimeKind);
  expect(session.run.failure).toBeUndefined();
  expect(session.eventCursor.lastEventSeq).toBe(events.at(-1)?.sequence);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  for (const eventType of requiredEventTypes) {
    expect(events.map((event) => event.type)).toContain(eventType);
  }
  expect(events.some((event) => event.type.startsWith("agent.") && event.type !== "agent.response")).toBe(
    true
  );

  expect(eventByType(events, "run.claimed").source).toBe("worker");
  expect(eventByType(events, sandboxLifecycleEventType).source).toBe("worker");
  if (requiredEventTypes.includes("credential_boundary.verified")) {
    expect(eventByType(events, "credential_boundary.verified").source).toBe("worker");
  }
  expect(eventByType(events, "provider.stdout").source).toBe(providerSource);
  expect(eventByType(events, "provider.stderr").source).toBe(providerSource);
  expect(eventByType(events, "agent.response").source).toBe(providerSource);
  expect(eventByType(events, "agent.response").payload).toMatchObject({
    provider: providerSource
  });
  expect(session.response?.text).toEqual(expect.any(String));
  expect(session.response?.text.length).toBeGreaterThan(0);
  expect(eventByType(events, "workspace.file_index_collected").source).toBe("worker");
  expect(eventByType(events, "workspace.patch_collected").source).toBe("worker");
  expect(eventByType(events, "run.completed").payload).toMatchObject({ message: "completed" });

  const artifactsByKind = mapArtifactsByKind(session.artifacts.items);
  expect([...artifactsByKind.keys()].sort()).toEqual([...expectedArtifactKinds].sort());
  expect(session.artifactManifest).toMatchObject({
    status: "available",
    artifactId: artifactsByKind.get("session_manifest")?.id
  });

  assertArtifactRefs(events, artifactsByKind);

  const stdoutBytes = await downloadAndVerifyHash(client, runId, requiredArtifact(artifactsByKind, "stdout_log"));
  const stderrBytes = await downloadAndVerifyHash(client, runId, requiredArtifact(artifactsByKind, "stderr_log"));
  const fileIndexBytes = await downloadAndVerifyHash(
    client,
    runId,
    requiredArtifact(artifactsByKind, "workspace_file_index")
  );
  const patchBytes = await downloadAndVerifyHash(
    client,
    runId,
    requiredArtifact(artifactsByKind, "workspace_patch")
  );
  const manifestBytes = await downloadAndVerifyHash(
    client,
    runId,
    requiredArtifact(artifactsByKind, "session_manifest")
  );
  const sessionEventsBytes = await downloadAndVerifyHash(
    client,
    runId,
    requiredArtifact(artifactsByKind, "session_events")
  );

  const stdoutText = gunzipSync(stdoutBytes).toString("utf8");
  const stderrText = gunzipSync(stderrBytes).toString("utf8");
  const fileIndexText = fileIndexBytes.toString("utf8");
  const patchText = patchBytes.toString("utf8");
  const manifestText = manifestBytes.toString("utf8");
  const sessionEventsText = sessionEventsBytes.toString("utf8");

  expect(stdoutText.length).toBeGreaterThan(0);
  expect(patchText).toContain(marker);
  expect(patchText).toContain(createdPath);

  const fileIndex = JSON.parse(fileIndexText) as { files?: Array<{ status: string; path: string }> };
  expect(fileIndex.files).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "??", path: createdPath })])
  );

  const manifest = JSON.parse(manifestText) as {
    run: { id: string; status: string; runtimeKind: string; lastEventSeq: number };
    events: Array<{ sequence: number; type: string }>;
    artifacts: Array<{ kind: string; r2Key: string; sha256: string; sizeBytes: number }>;
  };
  expect(manifest.run).toMatchObject({
    id: runId,
    status: "completed",
    runtimeKind,
    lastEventSeq: events.at(-1)?.sequence
  });
  for (const eventType of requiredEventTypes) {
    expect(manifest.events.map((event) => event.type)).toContain(eventType);
  }
  expect(manifest.artifacts.map((artifact) => artifact.kind).sort()).toEqual(
    ["session_events", "stderr_log", "stdout_log", "workspace_file_index", "workspace_patch"].sort()
  );
  expect(sessionEventsText.trim().split("\n").map((line) => JSON.parse(line).type)).toEqual(
    manifest.events.map((event) => event.type)
  );

  const searchableOutput = [
    JSON.stringify(events),
    stdoutText,
    stderrText,
    fileIndexText,
    patchText,
    manifestText,
    sessionEventsText
  ].join("\n");
  for (const canary of expectation.secretCanaries ?? []) {
    if (canary) expect(searchableOutput).not.toContain(canary);
  }
}

function eventByType(events: RunEvent[], type: string): RunEvent {
  const event = events.find((item) => item.type === type);
  if (!event) throw new Error(`Missing event ${type}`);
  return event;
}

function mapArtifactsByKind(artifacts: Artifact[]): Map<string, Artifact> {
  const byKind = new Map<string, Artifact>();
  for (const artifact of artifacts) {
    byKind.set(artifact.kind, artifact);
    expect(artifact.sizeBytes).toBeGreaterThan(0);
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  return byKind;
}

function assertArtifactRefs(events: RunEvent[], artifactsByKind: Map<string, Artifact>): void {
  const expectedRefs = new Map([
    ["provider.stdout", "stdout_log"],
    ["provider.stderr", "stderr_log"],
    ["workspace.file_index_collected", "workspace_file_index"],
    ["workspace.patch_collected", "workspace_patch"]
  ]);

  for (const [eventType, artifactKind] of expectedRefs) {
    const event = eventByType(events, eventType);
    const artifact = requiredArtifact(artifactsByKind, artifactKind);
    expect(event.artifactRef).toMatchObject({
      artifactId: artifact.id,
      r2Key: artifact.r2Key
    });
  }
}

function requiredArtifact(artifactsByKind: Map<string, Artifact>, kind: string): Artifact {
  const artifact = artifactsByKind.get(kind);
  if (!artifact) throw new Error(`Missing artifact ${kind}`);
  return artifact;
}

async function downloadAndVerifyHash(
  client: AgentRouterClient,
  runId: string,
  artifact: Artifact
): Promise<Buffer> {
  const bytes = Buffer.from(await client.downloadArtifact(runId, artifact.id));
  expect(hashSha256(bytes)).toBe(artifact.sha256);
  return bytes;
}

function hashSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
