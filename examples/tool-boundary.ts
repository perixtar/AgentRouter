import { hasHelpFlag, makeExampleClient } from "./shared.js";

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const lookupBuildStatusTool: ToolDefinition = {
  name: "lookup_build_status",
  description: "Return build status for a commit SHA from the caller's own system.",
  inputSchema: {
    type: "object",
    properties: {
      commitSha: {
        type: "string",
        minLength: 7,
        description: "Git commit SHA to inspect."
      }
    },
    required: ["commitSha"],
    additionalProperties: false
  }
};

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

const { baseUrl, apiKey } = makeExampleClient();

console.log("Example tool contract:");
console.log(JSON.stringify(lookupBuildStatusTool, null, 2));
console.log();
console.log("Phase 1 boundary check:");
console.log("Custom user tools are intentionally not accepted by /v1/runs yet.");
console.log("They should become MCP Gateway registrations in the tools phase.");

const response = await fetch(`${baseUrl}/v1/runs`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json"
  },
  body: JSON.stringify({
    task: "Use lookup_build_status for commit abc1234",
    runtime: { kind: "codex", mode: "default" },
    tools: [lookupBuildStatusTool]
  })
});

const payload = (await response.json()) as {
  error?: { code?: string; message?: string; details?: unknown };
};

if (response.status !== 400 || payload.error?.code !== "unsupported_tool_configuration") {
  console.error(`Expected unsupported_tool_configuration, got HTTP ${response.status}`);
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

console.log(`As expected: ${payload.error.code}: ${payload.error.message}`);

function printHelp(): void {
  console.log(`create tool example

Shows how a tool contract should be shaped, then demonstrates the current
Phase 1 behavior: custom user tools are rejected before worker claim.

This is intentional. Phase 1 supports the selected CLI runtime's built-in
sandbox tools only. User-defined tools should be registered through the future
AgentRouter MCP Gateway, not passed as raw functions into the sandbox.

Prerequisite:
  pnpm dev

Or run only the API:
  pnpm api:dev

Run:
  pnpm example:create-tool

Optional env:
  AGENTROUTER_API_BASE_URL=http://127.0.0.1:8787
  AGENTROUTER_API_KEY=<random-private-token>
`);
}
