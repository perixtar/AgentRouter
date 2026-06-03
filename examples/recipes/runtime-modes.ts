import { claudeCode, codex, runAgent, type CreateRunRequest } from "@agentrouterhq/sdk";
import { handleExampleError, hasHelpFlag, logRunEvent, makeExampleClient } from "../shared.js";

type RuntimeExample = {
  id: string;
  description: string;
  request: CreateRunRequest;
};

const examples: RuntimeExample[] = [
  {
    id: "codex-default",
    description: "Codex workspace-write run for normal coding tasks.",
    request: {
      task: "Reply exactly AR_RUNTIME_CODEX_DEFAULT_OK. Do not edit files.",
      runtime: codex({ mode: "default", model: process.env.AGENTROUTER_MODEL })
    }
  },
  {
    id: "codex-read-only",
    description: "Codex read-only run for inspection, summaries, and audits.",
    request: {
      task: "Inspect the current workspace and reply exactly AR_RUNTIME_CODEX_READ_ONLY_OK.",
      runtime: codex({ mode: "read_only", model: process.env.AGENTROUTER_MODEL })
    }
  },
  {
    id: "codex-full-access",
    description: "Codex full-access run for file edits inside the sandbox.",
    request: {
      task:
        "Use the shell tool to run exactly: mkdir -p reports && printf 'AR_RUNTIME_CODEX_FULL_ACCESS_OK\\n' > reports/runtime-mode.txt. Then summarize the change.",
      runtime: codex({ mode: "full_access", model: process.env.AGENTROUTER_MODEL })
    }
  },
  {
    id: "codex-auto-review",
    description: "Codex review-mode run for read-only code review workflows.",
    request: {
      task: "Review this workspace and report one concrete issue or say no issue found.",
      runtime: codex({ mode: "auto_review", model: process.env.AGENTROUTER_MODEL })
    }
  },
  {
    id: "claude-default",
    description: "Claude Code default permission mode.",
    request: {
      task: "Reply exactly AR_RUNTIME_CLAUDE_DEFAULT_OK. Do not edit files.",
      runtime: claudeCode({
        permissionMode: "default",
        model: process.env.AGENTROUTER_CLAUDE_MODEL ?? process.env.AGENTROUTER_MODEL
      })
    }
  },
  {
    id: "claude-plan",
    description: "Claude Code planning mode for analysis before edits.",
    request: {
      task: "Create a short plan for adding an AgentRouter example, but do not edit files.",
      runtime: claudeCode({
        permissionMode: "plan",
        model: process.env.AGENTROUTER_CLAUDE_MODEL ?? process.env.AGENTROUTER_MODEL
      })
    }
  }
];

if (hasHelpFlag()) {
  printHelp();
  process.exit(0);
}

const selectedId = process.env.AGENTROUTER_RUNTIME_EXAMPLE ?? "codex-read-only";
const selected = examples.find((item) => item.id === selectedId);

if (!selected) {
  console.error(`Unknown AGENTROUTER_RUNTIME_EXAMPLE=${selectedId}`);
  printCases();
  process.exit(1);
}

try {
  const { baseUrl, client } = makeExampleClient();
  console.log(`API: ${baseUrl}`);
  console.log(`Running ${selected.id}: ${selected.description}`);

  const result = await runAgent({
    client,
    ...selected.request,
    pollIntervalMs: 1000,
    maxWaitMs: 10 * 60 * 1000,
    onEvent: logRunEvent
  });

  console.log(`Run ${result.id}: ${result.status}`);
  console.log(result.text || "(no text response)");
  if (result.status !== "completed") {
    process.exitCode = 1;
  }
} catch (error) {
  handleExampleError(error);
}

function printCases(): void {
  console.log("Available cases:");
  for (const item of examples) {
    console.log(`  ${item.id.padEnd(18)} ${item.description}`);
  }
}

function printHelp(): void {
  console.log(`runtime modes recipe

Shows how public runtime options map to meaningful workflows. Set
AGENTROUTER_RUNTIME_EXAMPLE to choose one case.

Prerequisite:
  pnpm dev

Run default read-only Codex case:
  pnpm example:recipe:runtime-modes

Run a specific case:
  AGENTROUTER_RUNTIME_EXAMPLE=codex-full-access pnpm example:recipe:runtime-modes
  AGENTROUTER_RUNTIME_EXAMPLE=claude-plan pnpm example:recipe:runtime-modes

`);
  printCases();
}
