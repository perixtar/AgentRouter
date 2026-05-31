import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config as loadDotEnv } from "dotenv";
import { DaytonaSandboxDriver } from "@agentrouter/sandbox-daytona";
import { parseAgentRouterEnv } from "@agentrouter/config";

loadDotEnv();

describe("DaytonaSandboxDriver", () => {
  it("creates a real sandbox, executes a command, and deletes it", async () => {
    const config = parseAgentRouterEnv(process.env);
    const driver = new DaytonaSandboxDriver({
      apiKey: config.daytonaApiKey,
      testResourcePrefix: config.testResourcePrefix
    });
    const sandboxName = `${config.testResourcePrefix}-${randomUUID()}`;
    let sandboxId: string | undefined;

    try {
      const sandbox = await driver.createSandbox({
        name: sandboxName,
        env: {
          AGENTROUTER_SMOKE: "true"
        }
      });
      sandboxId = sandbox.id;

      const result = await driver.executeCommand(sandbox.id, "printf AR_DAYTONA_SMOKE_OK");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("AR_DAYTONA_SMOKE_OK");
    } finally {
      if (sandboxId) {
        await driver.deleteSandbox(sandboxId);
      }
    }
  }, 120_000);
});
