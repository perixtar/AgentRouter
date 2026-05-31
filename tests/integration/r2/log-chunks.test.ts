import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { R2ArtifactStore } from "@agentrouter/artifacts-r2";
import { parseAgentRouterEnv } from "@agentrouter/config";

loadDotEnv();

describe("R2 log chunks", () => {
  it("uploads compressed stdout chunks with checksums and prefix-confined cleanup", async () => {
    const config = parseAgentRouterEnv(process.env);
    const store = new R2ArtifactStore(config.r2);
    const runId = `run_${randomUUID()}`;
    const body = Buffer.from("stdout line 1\nstdout line 2\n", "utf8");

    try {
      const artifact = await store.putLogChunk({
        runId,
        stream: "stdout",
        chunkNumber: 1,
        body,
        eventSequenceStart: 1n,
        eventSequenceEnd: 2n,
        redactionStatus: "redacted"
      });

      expect(artifact.r2Key).toContain(`${config.r2.artifactPrefix}${runId}/logs/stdout/000001.ndjson.gz`);
      expect(artifact.uncompressedSizeBytes).toBe(body.byteLength);
      expect(artifact.compressedSizeBytes).toBeGreaterThan(0);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(artifact.metadata.eventSequenceStart).toBe("1");
      expect(artifact.metadata.redactionStatus).toBe("redacted");

      const downloaded = await store.getObjectBytes(artifact.r2Key);
      expect(gunzipSync(downloaded).toString("utf8")).toBe(body.toString("utf8"));
    } finally {
      await store.deleteRunPrefix(runId);
    }

    const remaining = await store.listRunKeys(runId);
    expect(remaining).toEqual([]);
  });
});
