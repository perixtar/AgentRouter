import { describe, expect, it } from "vitest";
import { transitionRunStatus } from "@agentrouter/core";

describe("transitionRunStatus", () => {
  it("allows the happy path from queued to completed", () => {
    expect(transitionRunStatus("queued", "starting")).toBe("starting");
    expect(transitionRunStatus("starting", "running")).toBe("running");
    expect(transitionRunStatus("running", "completed")).toBe("completed");
  });

  it("rejects transitions out of terminal states", () => {
    expect(() => transitionRunStatus("completed", "running")).toThrow(
      "Cannot transition from terminal state completed to running"
    );
  });

  it("allows cancellation from queued, starting, and running", () => {
    expect(transitionRunStatus("queued", "cancelling")).toBe("cancelling");
    expect(transitionRunStatus("starting", "cancelling")).toBe("cancelling");
    expect(transitionRunStatus("running", "cancelling")).toBe("cancelling");
    expect(transitionRunStatus("cancelling", "cancelled")).toBe("cancelled");
  });
});
