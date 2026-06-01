import { describe, expect, it } from "vitest";
import { parseAgentRouterEnv } from "@agentrouter/config";

describe("parseAgentRouterEnv", () => {
  it("uses OPENAI_API_KEY as the Phase 1A Codex key fallback", () => {
    const config = parseAgentRouterEnv({
      AGENTROUTER_API_KEY: "ar_test_local_secret",
      DAYTONA_API_KEY: "daytona",
      OPENAI_API_KEY: "openai",
      DATABASE_URL: "postgres://user:pass@localhost:5432/agentrouter",
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "bucket",
      R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      R2_REGION: "auto",
      R2_ARTIFACT_PREFIX: "dev/runs/",
      AGENTROUTER_TEST_RESOURCE_PREFIX: "ar-test",
      AGENTROUTER_HEARTBEAT_INTERVAL_SECONDS: "30",
      AGENTROUTER_STALE_HEARTBEAT_GRACE_SECONDS: "180",
      DAYTONA_SANDBOX_TTL_SECONDS: "900"
    });

    expect(config.codexApiKey).toBe("openai");
    expect(config.apiKey).toBe("ar_test_local_secret");
  });

  it("keeps ANTHROPIC_API_KEY optional but exposes it when configured", () => {
    const config = parseAgentRouterEnv({
      AGENTROUTER_API_KEY: "ar_test_local_secret",
      DAYTONA_API_KEY: "daytona",
      OPENAI_API_KEY: "openai",
      ANTHROPIC_API_KEY: "anthropic",
      DATABASE_URL: "postgres://user:pass@localhost:5432/agentrouter",
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "bucket",
      R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      R2_REGION: "auto",
      R2_ARTIFACT_PREFIX: "dev/runs/",
      AGENTROUTER_TEST_RESOURCE_PREFIX: "ar-test",
      AGENTROUTER_HEARTBEAT_INTERVAL_SECONDS: "30",
      AGENTROUTER_STALE_HEARTBEAT_GRACE_SECONDS: "180",
      DAYTONA_SANDBOX_TTL_SECONDS: "900"
    });

    expect(config.anthropicApiKey).toBe("anthropic");
  });

  it("requires an explicit non-default AgentRouter API key", () => {
    const input = {
      DAYTONA_API_KEY: "daytona",
      OPENAI_API_KEY: "openai",
      DATABASE_URL: "postgres://user:pass@localhost:5432/agentrouter",
      R2_ACCOUNT_ID: "account",
      R2_ACCESS_KEY_ID: "access",
      R2_SECRET_ACCESS_KEY: "secret",
      R2_BUCKET: "bucket",
      R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      R2_REGION: "auto",
      R2_ARTIFACT_PREFIX: "dev/runs/",
      AGENTROUTER_TEST_RESOURCE_PREFIX: "ar-test",
      AGENTROUTER_HEARTBEAT_INTERVAL_SECONDS: "30",
      AGENTROUTER_STALE_HEARTBEAT_GRACE_SECONDS: "180",
      DAYTONA_SANDBOX_TTL_SECONDS: "900"
    };

    expect(() => parseAgentRouterEnv(input)).toThrow();
    expect(() =>
      parseAgentRouterEnv({ ...input, AGENTROUTER_API_KEY: "ar_dev_local_change_me" })
    ).toThrow(/must be changed/);
  });
});
