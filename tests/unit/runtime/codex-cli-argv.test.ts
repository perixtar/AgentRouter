import { describe, expect, it } from "vitest";
import {
  buildCodexLaunchPlan,
  resolveCodexPermissionProfile
} from "@agentrouter/runtime-codex-cli";

describe("Codex CLI argv", () => {
  it("orders global and exec flags in a shape accepted by current Codex", () => {
    const plan = buildCodexLaunchPlan({
      mode: "default",
      task: "Summarize this repo",
      workdir: "/workspace/repo",
      providerEnv: { CODEX_API_KEY: "sk-canary" }
    });

    expect(plan.argv.slice(0, 5)).toEqual([
      "--ask-for-approval",
      "never",
      "--sandbox",
      "workspace-write",
      "--cd"
    ]);
    expect(plan.argv).toContain("exec");
    expect(plan.argv.indexOf("--ephemeral")).toBeGreaterThan(plan.argv.indexOf("exec"));
    expect(plan.argv.indexOf("--json")).toBeGreaterThan(plan.argv.indexOf("exec"));
    expect(plan.argv).toContain("-c");
    expect(plan.argv).toContain('shell_environment_policy.inherit="none"');
  });

  it("keeps full access behind the public mode resolver only", () => {
    const profile = resolveCodexPermissionProfile("full_access");

    expect(profile.sandbox).toBe("danger-full-access");
    expect(profile.requiresDaytonaIsolation).toBe(true);
    expect(() =>
      resolveCodexPermissionProfile("default", {
        rawArgs: ["--dangerously-bypass-approvals-and-sandbox"]
      })
    ).toThrow(/permission flags/);
  });

  it("builds auto-review as codex exec review JSON with base ref", () => {
    const plan = buildCodexLaunchPlan({
      mode: "auto_review",
      task: "Review this diff",
      workdir: "/workspace/repo",
      providerEnv: { CODEX_API_KEY: "sk-canary" },
      reviewBase: "main"
    });

    expect(plan.argv).toContain("review");
    expect(plan.argv.indexOf("review")).toBeGreaterThan(plan.argv.indexOf("exec"));
    expect(plan.argv).toContain("--json");
    expect(plan.argv).toContain("--base");
    expect(plan.argv).toContain("main");
    expect(plan.argv).toContain("read-only");
  });
});
