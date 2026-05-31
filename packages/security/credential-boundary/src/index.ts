export type ProviderName = "codex" | "claude_code";
export type CredentialStrategy = "provider_proxy" | "direct_env_proven";

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

function isDeniedEnvName(key: string): boolean {
  if (deniedExactNames.has(key)) return true;
  return deniedNamePatterns.some((pattern) => pattern.test(key));
}
