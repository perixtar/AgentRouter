import { describe, expect, it } from "vitest";
import {
  buildClaudeCodeLaunchPlan,
  resolveClaudeCodePermissionProfile
} from "@agentrouter/runtime-claude-code";

describe("Claude Code CLI argv", () => {
  it("builds headless stream-json print mode with provider credentials kept out of argv", () => {
    const plan = buildClaudeCodeLaunchPlan({
      permissionMode: "acceptEdits",
      model: "claude-sonnet-4-6",
      task: "Create reports/claude-smoke.txt",
      workdir: "/workspace/repo",
      providerEnv: { ANTHROPIC_API_KEY: "sk-ant-canary" }
    });

    expect(plan.command).toBe("claude");
    expect(plan.argv.slice(0, 8)).toEqual([
      "--bare",
      "-p",
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages"
    ]);
    expect(plan.argv).toContain("--no-session-persistence");
    expect(plan.argv).toContain("--disable-slash-commands");
    expect(plan.argv.at(plan.argv.indexOf("--model") + 1)).toBe("claude-sonnet-4-6");
    expect(plan.argv.at(-1)).toBe("Create reports/claude-smoke.txt");
    expect(plan.argv.join(" ")).not.toContain("sk-ant-canary");
    expect(plan.env.ANTHROPIC_API_KEY).toBe("sk-ant-canary");
    expect(plan.cwd).toBe("/workspace/repo");
  });

  it("maps every Phase 1B permission mode to audited Claude flags", () => {
    for (const permissionMode of [
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions"
    ] as const) {
      expect(resolveClaudeCodePermissionProfile(permissionMode)).toMatchObject({
        permissionMode,
        outputFormat: "stream-json",
        print: true,
        bare: true
      });
    }

    expect(resolveClaudeCodePermissionProfile("bypassPermissions")).toMatchObject({
      requiresDaytonaIsolation: true
    });
  });

  it("rejects raw Claude Code permission, tool, MCP, and session overrides", () => {
    expect(() =>
      resolveClaudeCodePermissionProfile("default", {
        rawArgs: ["--dangerously-skip-permissions"]
      })
    ).toThrow("Raw Claude Code flags are not accepted");

    expect(() =>
      resolveClaudeCodePermissionProfile("default", {
        rawArgs: ["--mcp-config"]
      })
    ).toThrow("Raw Claude Code flags are not accepted");
  });
});
