import { describe, expect, it } from "vitest";
import {
  buildProviderProcessEnv,
  redactCredentialCanaries,
  scrubToolEnvironment,
  scanForCredentialCanaries
} from "@agentrouter/credential-boundary";

describe("credential boundary", () => {
  it("keeps raw provider keys out of argv and general sandbox env", () => {
    const boundary = buildProviderProcessEnv({
      provider: "codex",
      rawProviderKey: "sk-test-canary",
      baseEnv: {
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        HOME: "/tmp/home",
        OPENAI_API_KEY: "sk-should-not-pass",
        R2_SECRET_ACCESS_KEY: "r2-secret"
      }
    });

    expect(boundary.credentialStrategy).toBe("direct_env_proven");
    expect(boundary.providerEnv.CODEX_API_KEY).toBe("sk-test-canary");
    expect(boundary.generalSandboxEnv.LANG).toBe("en_US.UTF-8");
    expect(boundary.generalSandboxEnv.PATH).toBeUndefined();
    expect(boundary.generalSandboxEnv.HOME).toBeUndefined();
    expect(boundary.generalSandboxEnv.OPENAI_API_KEY).toBeUndefined();
    expect(boundary.generalSandboxEnv.R2_SECRET_ACCESS_KEY).toBeUndefined();
    expect(JSON.stringify(boundary.argvSafeMetadata)).not.toContain("sk-test-canary");
  });

  it("scrubs model-generated tool environments", () => {
    const env = scrubToolEnvironment({
      PATH: "/usr/bin",
      TZ: "UTC",
      CODEX_API_KEY: "sk-codex",
      OPENAI_API_KEY: "sk-openai",
      AGENTROUTER_API_KEY: "ar_local",
      R2_SECRET_ACCESS_KEY: "r2-secret"
    });

    expect(env.PATH).toBeUndefined();
    expect(env.TZ).toBe("UTC");
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AGENTROUTER_API_KEY).toBeUndefined();
    expect(env.R2_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("detects credential canaries in output before archiving", () => {
    expect(scanForCredentialCanaries("safe output", ["sk-canary"])).toEqual([]);
    expect(scanForCredentialCanaries("leaked sk-canary", ["sk-canary"])).toEqual(["sk-canary"]);
  });

  it("redacts credential canaries before any content is safe to archive", () => {
    expect(redactCredentialCanaries("leaked sk-canary", ["sk-canary"])).toBe(
      "leaked [REDACTED]"
    );
  });
});
