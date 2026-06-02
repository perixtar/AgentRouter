import { z } from "zod";

export interface AgentRouterConfig {
  apiKey: string;
  webServiceToken?: string;
  masterKey?: string;
  daytonaApiKey: string;
  codexApiKey?: string;
  anthropicApiKey?: string;
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
  /** Minutes a finished one-shot sandbox stays suspended so a fast follow-up can resume it. */
  oneShotGraceMinutes: number;
  /** Minutes a continued conversation may sit idle (suspended) before the reaper deletes it. */
  sessionIdleTtlMinutes: number;
  /** Daytona-side auto-delete backstop (minutes) for persistent sandboxes. */
  sessionAutoStopMinutes: number;
  sessionAutoDeleteMinutes: number;
  /** How often the worker reaper sweeps for expired sandboxes (seconds). */
  reaperIntervalSeconds: number;
}

const envSchema = z.object({
  AGENTROUTER_API_KEY: z.string().min(1),
  // Shared web→API service token (web server holds it; Fastify trusts the
  // asserted X-AR-Org-Id when the bearer matches it). Optional so worker/tests
  // that don't serve the web path still boot.
  AGENTROUTER_WEB_SERVICE_TOKEN: z.string().min(1).optional(),
  // Master key for BYOK envelope encryption (AES-256-GCM, 32-byte base64).
  // Lives on Fly (API + worker) ONLY — never on Vercel. Optional so other
  // tooling boots; BYOK endpoints/worker assert it when actually used.
  AGENTROUTER_MASTER_KEY: z.string().min(1).optional(),
  DAYTONA_API_KEY: z.string().min(1),
  CODEX_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
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
  // ── Multi-turn run lifecycle / sandbox reclaim (env-tunable defaults). ──
  AGENTROUTER_ONESHOT_GRACE_MINUTES: z.coerce.number().int().positive().default(10),
  AGENTROUTER_SESSION_IDLE_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  AGENTROUTER_SESSION_AUTOSTOP_MINUTES: z.coerce.number().int().positive().default(15),
  AGENTROUTER_SESSION_AUTODELETE_MINUTES: z.coerce.number().int().positive().default(90),
  AGENTROUTER_REAPER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60)
});

export function parseAgentRouterEnv(input: NodeJS.ProcessEnv): AgentRouterConfig {
  const parsed = envSchema.parse(input);
  const codexApiKey = parsed.CODEX_API_KEY ?? parsed.OPENAI_API_KEY;
  assertNonDefaultApiKey(parsed.AGENTROUTER_API_KEY);

  return {
    apiKey: parsed.AGENTROUTER_API_KEY,
    webServiceToken: parsed.AGENTROUTER_WEB_SERVICE_TOKEN,
    masterKey: parsed.AGENTROUTER_MASTER_KEY,
    daytonaApiKey: parsed.DAYTONA_API_KEY,
    codexApiKey,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
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
    oneShotGraceMinutes: parsed.AGENTROUTER_ONESHOT_GRACE_MINUTES,
    sessionIdleTtlMinutes: parsed.AGENTROUTER_SESSION_IDLE_TTL_MINUTES,
    sessionAutoStopMinutes: parsed.AGENTROUTER_SESSION_AUTOSTOP_MINUTES,
    sessionAutoDeleteMinutes: parsed.AGENTROUTER_SESSION_AUTODELETE_MINUTES,
    reaperIntervalSeconds: parsed.AGENTROUTER_REAPER_INTERVAL_SECONDS
  };
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function assertNonDefaultApiKey(value: string): void {
  if (value === "ar_dev_local_change_me") {
    throw new Error("AGENTROUTER_API_KEY must be changed from the example development value");
  }
}
