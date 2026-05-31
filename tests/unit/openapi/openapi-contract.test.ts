import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("OpenAPI Phase 1 contract", () => {
  const spec = readFileSync("packages/openapi/openapi.yaml", "utf8");

  it("documents every public Phase 1 runtime endpoint", () => {
    for (const path of [
      "/v1/runs",
      "/v1/runs/{runId}",
      "/v1/runs/{runId}/session",
      "/v1/runs/{runId}/stream",
      "/v1/runs/{runId}/events",
      "/v1/runs/{runId}/cancel",
      "/v1/runs/{runId}/artifacts",
      "/v1/runs/{runId}/artifacts/{artifactId}/download"
    ]) {
      expect(spec).toContain(path);
    }
  });

  it("keeps runtime kinds and modes explicit", () => {
    expect(spec).toContain("codex");
    expect(spec).toContain("claude_code");
    expect(spec).toContain("full_access");
    expect(spec).toContain("auto_review");
  });
});
