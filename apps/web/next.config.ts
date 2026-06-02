import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

// The SDK ships raw TypeScript (its package `exports` points at an unbuilt
// `dist`). Resolve the workspace package directly to its source and let Next
// transpile it. This keeps the published SDK contract unchanged while letting
// the web app consume it without a separate build step.
const sdkSource = fileURLToPath(
  new URL("../../packages/sdk-typescript/src/index.ts", import.meta.url)
);

const nextConfig: NextConfig = {
  // pg is only used in server-only modules (route handlers / server actions).
  // Keep it external so the bundler doesn't try to pull it into client code.
  serverExternalPackages: ["pg"],
  // Transpile the SDK (raw TS) for both the dev and prod bundlers.
  transpilePackages: ["@agentrouter/sdk"],
  turbopack: {
    resolveAlias: {
      "@agentrouter/sdk": sdkSource
    }
  },
  webpack(config) {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@agentrouter/sdk": sdkSource
    };
    return config;
  }
};

export default nextConfig;
