import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/test.yml", "utf8");

describe("GitHub Actions E2E contract", () => {
  it("runs required live E2E jobs on trusted pushes and manual dispatch, never pull requests", () => {
    for (const jobName of ["external-smoke", "e2e-codex"]) {
      const job = workflowJob(jobName);

      expect(job).toContain("needs: local");
      expect(job).toContain("if: github.event_name != 'pull_request'");
      expect(job).not.toContain("github.event_name == 'workflow_dispatch'");
      expect(job).not.toContain("vars.RUN_CLAUDE_E2E");
    }
  });

  it("keeps Claude Code E2E in CI behind an explicit funded-account switch", () => {
    const claude = workflowJob("e2e-claude");

    expect(workflow).toContain("run_claude_e2e:");
    expect(claude).toContain("needs: local");
    expect(claude).toContain("github.event_name != 'pull_request'");
    expect(claude).toContain("vars.RUN_CLAUDE_E2E == '1'");
    expect(claude).toContain("inputs.run_claude_e2e");
    expect(claude).toContain("pnpm test:e2e:claude");
  });

  it("fails fast when live E2E secrets are missing and runs the strict suites", () => {
    const externalSmoke = workflowJob("external-smoke");
    const codex = workflowJob("e2e-codex");
    const claude = workflowJob("e2e-claude");

    expect(externalSmoke).toContain("Run external smoke tests");
    expect(externalSmoke).toContain("pnpm test:external");
    expect(codex).toContain("Validate Codex E2E secrets");
    expect(codex).toContain("pnpm test:e2e:codex");
    expect(claude).toContain("Validate Claude Code E2E secrets");
    expect(claude).toContain("pnpm test:e2e:claude");

    for (const secretName of [
      "DAYTONA_API_KEY",
      "OPENAI_API_KEY",
      "R2_ACCESS_KEY_ID",
      "R2_ACCOUNT_ID",
      "R2_BUCKET",
      "R2_ENDPOINT",
      "R2_SECRET_ACCESS_KEY"
    ]) {
      expect(codex).toContain(secretName);
    }
    expect(claude).toContain("ANTHROPIC_API_KEY");
  });
});

function workflowJob(name: string): string {
  const match = workflow.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:\\n|\\n$)`));
  if (!match?.[1]) throw new Error(`Missing workflow job ${name}`);
  return match[1];
}
