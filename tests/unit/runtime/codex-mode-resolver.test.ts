import { describe, expect, it } from "vitest";
import { resolveCodexPermissionProfile } from "@agentrouter/runtime-codex-cli";

describe("resolveCodexPermissionProfile", () => {
  it("maps every Phase 1A public mode to audited Codex flags", () => {
    expect(resolveCodexPermissionProfile("default")).toMatchObject({
      sandbox: "workspace-write",
      askForApproval: "never"
    });
    expect(resolveCodexPermissionProfile("read_only")).toMatchObject({
      sandbox: "read-only",
      askForApproval: "never"
    });
    expect(resolveCodexPermissionProfile("full_access")).toMatchObject({
      sandbox: "danger-full-access",
      requiresDaytonaIsolation: true
    });
    expect(resolveCodexPermissionProfile("auto_review")).toMatchObject({
      sandbox: "read-only",
      command: "review"
    });
  });

  it("rejects unsafe raw runtime overrides", () => {
    expect(() =>
      resolveCodexPermissionProfile("default", {
        rawArgs: ["--dangerously-bypass-approvals-and-sandbox"]
      })
    ).toThrow("Raw Codex permission flags are not accepted");
  });
});
