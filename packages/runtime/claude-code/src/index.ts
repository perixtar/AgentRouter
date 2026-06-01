import type { ClaudeCodePermissionMode } from "@agentrouter/core";

export interface ClaudeCodePermissionProfile {
  permissionMode: ClaudeCodePermissionMode;
  bare: true;
  print: true;
  outputFormat: "stream-json";
  includePartialMessages: true;
  sessionPersistence: false;
  slashCommandsDisabled: true;
  requiresDaytonaIsolation: boolean;
  argv: string[];
}

export interface ResolveClaudeCodeOptions {
  rawArgs?: string[];
}

export interface ClaudeCodeLaunchPlanInput {
  permissionMode: ClaudeCodePermissionMode;
  model?: string;
  task: string;
  workdir: string;
  providerEnv: Record<string, string>;
}

export interface ClaudeCodeLaunchPlan {
  command: "claude";
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  permissionProfile: ClaudeCodePermissionProfile;
}

const forbiddenRawArgs = new Set([
  "--allow-dangerously-skip-permissions",
  "--allowedTools",
  "--allowed-tools",
  "--continue",
  "--dangerously-skip-permissions",
  "--disallowedTools",
  "--disallowed-tools",
  "--fallback-model",
  "--mcp-config",
  "--plugin-dir",
  "--resume",
  "--settings",
  "--setting-sources",
  "--tools",
  "bypassPermissions",
  "dangerously-skip-permissions"
]);

export function resolveClaudeCodePermissionProfile(
  permissionMode: ClaudeCodePermissionMode,
  options: ResolveClaudeCodeOptions = {}
): ClaudeCodePermissionProfile {
  assertNoRawOverrides(options.rawArgs ?? []);

  return {
    permissionMode,
    bare: true,
    print: true,
    outputFormat: "stream-json",
    includePartialMessages: true,
    sessionPersistence: false,
    slashCommandsDisabled: true,
    requiresDaytonaIsolation: permissionMode === "bypassPermissions",
    argv: ["claude"]
  };
}

export function buildClaudeCodeLaunchPlan(input: ClaudeCodeLaunchPlanInput): ClaudeCodeLaunchPlan {
  const permissionProfile = resolveClaudeCodePermissionProfile(input.permissionMode);
  const [command, ...profileArgs] = permissionProfile.argv;
  const argv = [
    ...profileArgs,
    "--bare",
    "-p",
    "--permission-mode",
    permissionProfile.permissionMode,
    "--output-format",
    permissionProfile.outputFormat,
    "--verbose",
    "--include-partial-messages",
    "--no-session-persistence",
    "--disable-slash-commands",
    ...modelArgs(input.model),
    input.task
  ];

  if (command !== "claude") {
    throw new Error(`Unexpected Claude Code command: ${command}`);
  }

  return {
    command,
    argv,
    env: { ...input.providerEnv },
    cwd: input.workdir,
    permissionProfile
  };
}

function assertNoRawOverrides(rawArgs: string[]): void {
  if (rawArgs.some((arg) => forbiddenRawArgs.has(arg))) {
    throw new Error("Raw Claude Code flags are not accepted");
  }
}

function modelArgs(model: string | undefined): string[] {
  const trimmed = model?.trim();
  return trimmed ? ["--model", trimmed] : [];
}
