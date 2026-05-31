import { describe, expect, it } from "vitest";
import { normalizeEventPayload } from "@agentrouter/core";

describe("normalizeEventPayload", () => {
  it("keeps small payloads inline", () => {
    const payload = normalizeEventPayload({
      type: "command.output",
      text: "hello"
    });

    expect(payload.isTruncated).toBe(false);
    expect(payload.artifactRef).toBeUndefined();
    expect(payload.payload.text).toBe("hello");
  });

  it("truncates oversized text and emits an artifact reference", () => {
    const payload = normalizeEventPayload(
      {
        type: "command.output",
        text: "x".repeat(40_000)
      },
      { artifactId: "art_123", r2Key: "dev/runs/run_123/logs/stdout/000001.ndjson.gz" }
    );

    expect(payload.isTruncated).toBe(true);
    expect(String(payload.payload.text).length).toBeLessThanOrEqual(8 * 1024);
    expect(payload.artifactRef?.artifactId).toBe("art_123");
    expect(payload.payloadSizeBytes).toBeLessThanOrEqual(32 * 1024);
  });
});
