import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000
  },
  resolve: {
    alias: {
      "@agentrouter/core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@agentrouter/config": new URL("./packages/config/src/index.ts", import.meta.url).pathname,
      "@agentrouter/db": new URL("./packages/db/src/index.ts", import.meta.url).pathname,
      "@agentrouter/artifacts-r2": new URL("./packages/artifacts/r2/src/index.ts", import.meta.url).pathname,
      "@agentrouter/sandbox-daytona": new URL("./packages/sandbox/daytona/src/index.ts", import.meta.url).pathname,
      "@agentrouter/credential-boundary": new URL("./packages/security/credential-boundary/src/index.ts", import.meta.url).pathname,
      "@agentrouter/runtime-codex-cli": new URL("./packages/runtime/codex-cli/src/index.ts", import.meta.url).pathname,
      "@agentrouter/worker": new URL("./packages/worker/src/index.ts", import.meta.url).pathname,
      "@agentrouter/api": new URL("./apps/api/src/server.ts", import.meta.url).pathname,
      "@agentrouter/sdk": new URL("./packages/sdk-typescript/src/index.ts", import.meta.url).pathname
    }
  }
});
