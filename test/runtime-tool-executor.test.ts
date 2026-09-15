import { describe, expect, it } from "vitest";
import { createAgentState } from "../spec/agent.js";
import { ToolExecutor } from "../src/runtime/tool-executor.js";

describe("ToolExecutor", () => {
  it("routes tool execution through the runtime and records the call", async () => {
    const state = createAgentState({ rawText: "test" });
    const executor = new ToolExecutor(state);

    const result = await executor.execute<
      { constraints: unknown },
      unknown
    >("generate_followup_questions", { constraints: {} });

    expect(["success", "partial", "error"]).toContain(result.status);
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].toolName).toBe("generate_followup_questions");
    expect(state.messages.at(-1)?.kind).toBe("tool_result");
  });

  it("records an explicit error instead of bypassing the runtime for an unknown tool", async () => {
    const state = createAgentState({ rawText: "test" });
    const executor = new ToolExecutor(state);

    const result = await executor.execute("missing_tool", {});

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.errorInfo.code).toBe("E_RESOURCE_NOT_FOUND");
    }
    expect(state.toolCalls[0].errorCode).toBe("E_RESOURCE_NOT_FOUND");
    expect(state.messages.at(-1)?.kind).toBe("tool_result");
  });
});
