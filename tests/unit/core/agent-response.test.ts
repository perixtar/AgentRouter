import { describe, expect, it } from "vitest";
import {
  extractAgentResponseFromStdout,
  extractNormalizedAgentEventsFromStdout,
  sanitizeProviderStdoutForArchive
} from "@agentrouter/core";

describe("extractAgentResponseFromStdout", () => {
  it("extracts Codex agent messages from stdout JSONL", () => {
    const stdout = [
      "Reading additional input from stdin...",
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Codex final answer" }
      })
    ].join("\n");

    expect(extractAgentResponseFromStdout(stdout)).toEqual({
      text: "Codex final answer",
      parts: [{ type: "text", text: "Codex final answer" }],
      providerEventType: "item.completed"
    });
  });

  it("extracts Claude assistant messages from stdout JSONL", () => {
    const stdout = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Claude final answer" }]
      }
    });

    expect(extractAgentResponseFromStdout(stdout)).toMatchObject({
      text: "Claude final answer",
      parts: [{ type: "text", text: "Claude final answer" }],
      providerEventType: "assistant"
    });
  });

  it("uses the last user-visible provider message", () => {
    const stdout = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "intermediate" }
      }),
      JSON.stringify({ type: "result", result: "final result" })
    ].join("\n");

    expect(extractAgentResponseFromStdout(stdout)?.text).toBe("final result");
  });
});

describe("extractNormalizedAgentEventsFromStdout", () => {
  it("maps Codex JSONL into stable public agent events", () => {
    const stdout = [
      "Reading additional input from stdin...",
      JSON.stringify({ type: "thread.started", thread_id: "thread_123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Codex final answer" }
      }),
      JSON.stringify({ type: "result", result: "done" })
    ].join("\n");

    expect(extractNormalizedAgentEventsFromStdout("codex", stdout)).toEqual([
      {
        type: "agent.started",
        visibility: "public",
        providerEventType: "thread.started",
        payload: { provider: "codex", threadId: "thread_123" }
      },
      {
        type: "agent.message",
        visibility: "public",
        providerEventType: "item.completed",
        payload: { provider: "codex", text: "Codex final answer" }
      },
      {
        type: "agent.completed",
        visibility: "public",
        providerEventType: "result",
        payload: { provider: "codex", message: "done" }
      }
    ]);
  });

  it("maps Claude Code JSONL into stable public agent events", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess_123" }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Claude final answer" }]
        }
      }),
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "Credit balance is too low"
      })
    ].join("\n");

    expect(extractNormalizedAgentEventsFromStdout("claude_code", stdout)).toEqual([
      {
        type: "agent.started",
        visibility: "public",
        providerEventType: "system",
        payload: { provider: "claude_code", sessionId: "sess_123" }
      },
      {
        type: "agent.message",
        visibility: "public",
        providerEventType: "assistant",
        payload: { provider: "claude_code", text: "Claude final answer" }
      },
      {
        type: "agent.error",
        visibility: "public",
        providerEventType: "result",
        payload: { provider: "claude_code", message: "Credit balance is too low" }
      }
    ]);
  });

  it("maps Codex reasoning summaries into safe progress events without raw reasoning", () => {
    const stdout = JSON.stringify({
      type: "item.completed",
      item: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Inspected the failing test output." }],
        content: [{ type: "reasoning_text", text: "raw hidden reasoning must not be exposed" }]
      }
    });

    expect(extractNormalizedAgentEventsFromStdout("codex", stdout)).toEqual([
      {
        type: "agent.progress",
        visibility: "public",
        providerEventType: "item.completed",
        payload: {
          provider: "codex",
          summary: "Inspected the failing test output."
        }
      }
    ]);
    expect(JSON.stringify(extractNormalizedAgentEventsFromStdout("codex", stdout))).not.toContain(
      "raw hidden reasoning"
    );
  });

  it("detects repeated failed Codex command executions as no-progress events", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread_loop" }),
      ...Array.from({ length: 3 }, () =>
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "pnpm test",
            exit_code: 1,
            stdout: "1 failing test",
            stderr: "Expected 1 to be 2"
          }
        })
      )
    ].join("\n");

    expect(extractNormalizedAgentEventsFromStdout("codex", stdout)).toContainEqual({
      type: "agent.no_progress",
      visibility: "public",
      providerEventType: "item.completed",
      payload: expect.objectContaining({
        provider: "codex",
        signal: "repeated_command",
        reason: "Repeated command failed with similar output",
        command: "pnpm test",
        occurrences: 3,
        exitCode: 1,
        outputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      })
    });
  });

  it("detects repeated Claude Code edit attempts as no-progress events", () => {
    const editToolUse = {
      type: "tool_use",
      name: "Edit",
      input: {
        file_path: "/repo/src/service.ts",
        old_string: "return false;",
        new_string: "return true;"
      }
    };
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess_loop" }),
      ...Array.from({ length: 3 }, () =>
        JSON.stringify({
          type: "assistant",
          message: {
            content: [editToolUse]
          }
        })
      )
    ].join("\n");

    expect(extractNormalizedAgentEventsFromStdout("claude_code", stdout)).toContainEqual({
      type: "agent.no_progress",
      visibility: "public",
      providerEventType: "assistant",
      payload: expect.objectContaining({
        provider: "claude_code",
        signal: "repeated_edit",
        reason: "Repeated file edit did not produce meaningful progress",
        path: "/repo/src/service.ts",
        occurrences: 3,
        editDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      })
    });
  });
});

describe("sanitizeProviderStdoutForArchive", () => {
  it("keeps reasoning summaries but strips raw reasoning content from archived stdout", () => {
    const stdout = JSON.stringify({
      type: "item.completed",
      item: {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Inspected the failing test output." }],
        content: [{ type: "reasoning_text", text: "raw hidden reasoning must not be exposed" }]
      }
    });

    const sanitized = sanitizeProviderStdoutForArchive(stdout);

    expect(sanitized).toContain("Inspected the failing test output.");
    expect(sanitized).not.toContain("raw hidden reasoning");
  });
});
