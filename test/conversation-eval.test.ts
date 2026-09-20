import { describe, expect, it } from "vitest";
import { CONVERSATION_CASES } from "../eval/conversation-cases.js";
import { runConversationCase } from "../eval/conversation.js";

describe("multi-turn task evaluation", () => {
  it("memory reduces errors on a representative complete task", async () => {
    const testCase = CONVERSATION_CASES[2];
    const stateless = await runConversationCase(testCase, false);
    const withMemory = await runConversationCase(testCase, true);

    expect(withMemory.taskSuccess).toBe(true);
    expect(withMemory.memoryChecks).toBeGreaterThan(0);
    expect(withMemory.memoryErrors).toBeLessThan(stateless.memoryErrors);
    expect(withMemory.turns).toBe(testCase.turns.length);
  });
});
