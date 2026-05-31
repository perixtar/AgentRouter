import { describe, expect, it } from "vitest";
import { buildCodexLaunchPlan } from "@agentrouter/runtime-codex-cli";

describe("buildCodexLaunchPlan", () => {
  it("keeps provider credentials out of argv", () => {
    const plan = buildCodexLaunchPlan({
      mode: "default",
      task: "Summarize this repo",
      workdir: "/workspace/repo",
      providerEnv: { CODEX_API_KEY: "sk-canary" }
    });

    expect(plan.command).toBe("codex");
    expect(plan.argv.join(" ")).not.toContain("sk-canary");
    expect(plan.env.CODEX_API_KEY).toBe("sk-canary");
    expect(plan.cwd).toBe("/workspace/repo");
  });

  it("builds auto-review as review command under read-only sandbox", () => {
    const plan = buildCodexLaunchPlan({
      mode: "auto_review",
      task: "Review this diff",
      workdir: "/workspace/repo",
      providerEnv: { CODEX_API_KEY: "sk-canary" },
      reviewBase: "main"
    });

    expect(plan.argv).toContain("review");
    expect(plan.argv).toContain("--base");
    expect(plan.argv).toContain("main");
    expect(plan.argv).toContain("read-only");
  });
});
