import type { RuntimeMode } from "@agentrouter/core";

export interface CodexPermissionProfile {
  mode: RuntimeMode;
  sandbox: "workspace-write" | "read-only" | "danger-full-access";
  askForApproval: "never";
  command: "exec" | "review";
  requiresDaytonaIsolation: boolean;
  argv: string[];
}

export interface ResolveCodexOptions {
  rawArgs?: string[];
}

export interface CodexLaunchPlanInput {
  mode: RuntimeMode;
  task: string;
  workdir: string;
  providerEnv: Record<string, string>;
  reviewBase?: string;
}

export interface CodexLaunchPlan {
  command: "codex";
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  permissionProfile: CodexPermissionProfile;
}

const forbiddenRawArgs = new Set([
  "--full-auto",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "danger-full-access"
]);

export function resolveCodexPermissionProfile(
  mode: RuntimeMode,
  options: ResolveCodexOptions = {}
): CodexPermissionProfile {
  assertNoRawPermissionOverrides(options.rawArgs ?? []);

  if (mode === "auto_review") {
    return profile(mode, "read-only", "review", false);
  }

  if (mode === "read_only") {
    return profile(mode, "read-only", "exec", false);
  }

  if (mode === "full_access") {
    return profile(mode, "danger-full-access", "exec", true);
  }

  return profile(mode, "workspace-write", "exec", false);
}

function profile(
  mode: RuntimeMode,
  sandbox: CodexPermissionProfile["sandbox"],
  command: CodexPermissionProfile["command"],
  requiresDaytonaIsolation: boolean
): CodexPermissionProfile {
  return {
    mode,
    sandbox,
    askForApproval: "never",
    command,
    requiresDaytonaIsolation,
    argv: ["codex"]
  };
}

function assertNoRawPermissionOverrides(rawArgs: string[]): void {
  if (rawArgs.some((arg) => forbiddenRawArgs.has(arg))) {
    throw new Error("Raw Codex permission flags are not accepted");
  }
}

export function buildCodexLaunchPlan(input: CodexLaunchPlanInput): CodexLaunchPlan {
  const permissionProfile = resolveCodexPermissionProfile(input.mode);
  const [command, ...profileArgs] = permissionProfile.argv;
  const argv = [
    ...profileArgs,
    "--ask-for-approval",
    "never",
    "--sandbox",
    permissionProfile.sandbox,
    "--cd",
    input.workdir,
    "exec",
    ...execArgs(permissionProfile, input),
    ...reviewArgs(input),
    input.task
  ];

  if (command !== "codex") {
    throw new Error(`Unexpected Codex command: ${command}`);
  }

  return {
    command,
    argv,
    env: { ...input.providerEnv },
    cwd: input.workdir,
    permissionProfile
  };
}

function execArgs(
  permissionProfile: CodexPermissionProfile,
  input: CodexLaunchPlanInput
): string[] {
  const shared = [
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    'shell_environment_policy.inherit="none"'
  ];

  if (permissionProfile.command === "review") {
    return ["review", "--json", ...shared];
  }

  return ["--json", ...shared];
}

function reviewArgs(input: CodexLaunchPlanInput): string[] {
  if (input.mode !== "auto_review") return [];
  return input.reviewBase ? ["--base", input.reviewBase] : [];
}
