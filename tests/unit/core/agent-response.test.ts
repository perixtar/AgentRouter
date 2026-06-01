import { describe, expect, it } from "vitest";
import { extractAgentResponseFromStdout } from "@agentrouter/core";

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
