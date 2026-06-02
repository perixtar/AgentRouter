import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pg is only used in server-only modules (route handlers / server actions).
  // Keep it external so the bundler doesn't try to pull it into client code.
  serverExternalPackages: ["pg"]
};

export default nextConfig;
