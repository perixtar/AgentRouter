import { z } from "zod";

export interface AgentRouterConfig {
  apiKey: string;
  daytonaApiKey: string;
  codexApiKey: string;
  databaseUrl: string;
  r2: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    endpoint: string;
    region: string;
    artifactPrefix: string;
  };
  testResourcePrefix: string;
  heartbeatIntervalSeconds: number;
  staleHeartbeatGraceSeconds: number;
  daytonaSandboxTtlSeconds: number;
  e2eRepoUrl?: string;
  e2eRepoBaseRef: string;
}

const envSchema = z.object({
  AGENTROUTER_API_KEY: z.string().min(1).optional(),
  DAYTONA_API_KEY: z.string().min(1),
  CODEX_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_ENDPOINT: z.string().url(),
  R2_REGION: z.string().min(1).default("auto"),
  R2_ARTIFACT_PREFIX: z.string().min(1),
  AGENTROUTER_TEST_RESOURCE_PREFIX: z.string().min(1),
  AGENTROUTER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().positive(),
  AGENTROUTER_STALE_HEARTBEAT_GRACE_SECONDS: z.coerce.number().int().positive(),
  DAYTONA_SANDBOX_TTL_SECONDS: z.coerce.number().int().positive(),
  AGENTROUTER_E2E_REPO_URL: z.string().url().optional(),
  AGENTROUTER_E2E_REPO_BASE_REF: z.string().min(1).default("main")
});

export function parseAgentRouterEnv(input: NodeJS.ProcessEnv): AgentRouterConfig {
  const parsed = envSchema.parse(input);
  const codexApiKey = parsed.CODEX_API_KEY ?? parsed.OPENAI_API_KEY;

  if (!codexApiKey) {
    throw new Error("Missing CODEX_API_KEY or OPENAI_API_KEY for Phase 1A Codex runtime");
  }

  return {
    apiKey: parsed.AGENTROUTER_API_KEY ?? "ar_dev_local_change_me",
    daytonaApiKey: parsed.DAYTONA_API_KEY,
    codexApiKey,
    databaseUrl: parsed.DATABASE_URL,
    r2: {
      accountId: parsed.R2_ACCOUNT_ID,
      accessKeyId: parsed.R2_ACCESS_KEY_ID,
      secretAccessKey: parsed.R2_SECRET_ACCESS_KEY,
      bucket: parsed.R2_BUCKET,
      endpoint: parsed.R2_ENDPOINT,
      region: parsed.R2_REGION,
      artifactPrefix: ensureTrailingSlash(parsed.R2_ARTIFACT_PREFIX)
    },
    testResourcePrefix: parsed.AGENTROUTER_TEST_RESOURCE_PREFIX,
    heartbeatIntervalSeconds: parsed.AGENTROUTER_HEARTBEAT_INTERVAL_SECONDS,
    staleHeartbeatGraceSeconds: parsed.AGENTROUTER_STALE_HEARTBEAT_GRACE_SECONDS,
    daytonaSandboxTtlSeconds: parsed.DAYTONA_SANDBOX_TTL_SECONDS,
    e2eRepoUrl: parsed.AGENTROUTER_E2E_REPO_URL,
    e2eRepoBaseRef: parsed.AGENTROUTER_E2E_REPO_BASE_REF
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
