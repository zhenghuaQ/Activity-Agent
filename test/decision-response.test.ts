import { describe, expect, it } from "vitest";
import { parseDecisionResponse, parseDecisionStage } from "../spec/decision-response.js";
import { decisionFixture } from "./fixtures/decision.js";
import { runFullPipeline } from "../src/planner/engine.js";
import { parseIntent } from "../src/intent/parser.js";

describe("决策响应边界", () => {
  it("接受真实规划产出以及缺少可选评分的方案", async () => {
    const result = await runFullPipeline("一家三口下午游玩", parseIntent);
    const body = { success: result.success, message: result.message, decision: result.state.decision,
      selectedPlan: result.state.selectedPlan, notes: result.state.planningNotes ?? [] };
    expect(parseDecisionResponse(JSON.parse(JSON.stringify(body))).success).toBe(true);
    const fixture = decisionFixture();
    delete fixture.decision!.recommended.plan.score;
    delete fixture.decision!.recommended.plan.explanation;
    expect(parseDecisionResponse(fixture)).toBe(fixture);
  });

  it("拒绝会破坏渲染的嵌套字段", () => {
    const fixture = decisionFixture();
    const badPlan = { ...fixture.decision!.recommended.plan, activities: [{ place: null }] };
    expect(() => parseDecisionResponse({ ...fixture, decision: { ...fixture.decision, recommended: { ...fixture.decision!.recommended, plan: badPlan } } })).toThrow("决策结果结构无效");
    expect(() => parseDecisionResponse({ ...fixture, notes: [1] })).toThrow();
    expect(() => parseDecisionResponse(null)).toThrow();
    expect(() => parseDecisionStage({ stage: "unknown", message: "text" })).toThrow();
    expect(parseDecisionStage({ stage: "fine_scheduling", message: "完成" }).stage).toBe("fine_scheduling");
  });
});
