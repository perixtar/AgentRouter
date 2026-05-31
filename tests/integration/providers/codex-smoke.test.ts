import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { parseAgentRouterEnv } from "@agentrouter/config";

const execFileAsync = promisify(execFile);
loadDotEnv();

describe("Codex provider smoke", () => {
  it("has a real Codex CLI and server-side API key available", async () => {
    const config = parseAgentRouterEnv(process.env);
    expect(config.codexApiKey.length).toBeGreaterThan(10);

    const { stdout } = await execFileAsync("codex", ["--version"]);
    expect(stdout).toMatch(/codex/i);
  });
});
