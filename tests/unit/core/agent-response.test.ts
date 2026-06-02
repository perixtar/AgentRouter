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
