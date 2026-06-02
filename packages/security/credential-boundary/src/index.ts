export type ProviderName = "codex" | "claude_code";
export type CredentialStrategy = "provider_proxy" | "direct_env_proven";

export const CREDENTIAL_BOUNDARY_PROBE_MARKER = "AGENTROUTER_CREDENTIAL_BOUNDARY_PROBE";

export interface ProviderProcessEnvInput {
  provider: ProviderName;
  rawProviderKey: string;
  baseEnv: NodeJS.ProcessEnv;
  credentialStrategy?: CredentialStrategy;
}

export interface ProviderProcessEnv {
  credentialStrategy: CredentialStrategy;
  providerEnv: Record<string, string>;
  generalSandboxEnv: Record<string, string>;
  argvSafeMetadata: {
    provider: ProviderName;
    credentialStrategy: CredentialStrategy;
  };
}

const deniedExactNames = new Set([
  "AGENTROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "CODEX_API_KEY",
  "DAYTONA_API_KEY",
  "OPENAI_API_KEY",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY"
]);

const deniedNamePatterns = [/API_KEY$/i, /SECRET/i, /TOKEN$/i, /PASSWORD$/i, /CREDENTIAL/i];
const safeGeneralEnvNames = new Set(["LANG", "LC_ALL", "TERM", "TZ"]);

export function buildProviderProcessEnv(input: ProviderProcessEnvInput): ProviderProcessEnv {
  const credentialStrategy = input.credentialStrategy ?? "direct_env_proven";
  const providerEnvName = input.provider === "codex" ? "CODEX_API_KEY" : "ANTHROPIC_API_KEY";

  return {
    credentialStrategy,
    providerEnv: {
      [providerEnvName]: input.rawProviderKey
    },
    generalSandboxEnv: scrubToolEnvironment(input.baseEnv),
    argvSafeMetadata: {
      provider: input.provider,
      credentialStrategy
    }
  };
}

export function scrubToolEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const scrubbed: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!safeGeneralEnvNames.has(key)) continue;
    if (isDeniedEnvName(key)) continue;
    scrubbed[key] = value;
  }

  return scrubbed;
}

export function scanForCredentialCanaries(output: string, canaries: string[]): string[] {
  return canaries.filter((canary) => canary.length > 0 && output.includes(canary));
}

export function redactCredentialCanaries(output: string, canaries: string[]): string {
  return canaries.reduce(
    (redacted, canary) => (canary.length > 0 ? redacted.replaceAll(canary, "[REDACTED]") : redacted),
    output
  );
}

export function buildCredentialBoundaryProbeCommand(): string {
  return [
    "set +e",
    `printf '${CREDENTIAL_BOUNDARY_PROBE_MARKER}\\n'`,
    "printf '%s\\n' '--env--'",
    "env | sort",
    "printf '%s\\n' '--proc--'",
    "for file in /proc/$$/cmdline /proc/$$/environ; do printf '%s\\n' \"$file\"; tr '\\0' '\\n' < \"$file\" 2>/dev/null || true; done",
    "printf '%s\\n' '--home--'",
    "if [ -n \"$HOME\" ] && [ -d \"$HOME\" ]; then find \"$HOME\" -maxdepth 3 -type f \\( -name '*auth*' -o -name '*config*' -o -name '*.json' -o -name '*.toml' -o -name '*.env' \\) -print -exec sed -n '1,120p' {} \\; 2>/dev/null || true; fi"
  ].join("; ");
}

function isDeniedEnvName(key: string): boolean {
  if (deniedExactNames.has(key)) return true;
  return deniedNamePatterns.some((pattern) => pattern.test(key));
}
