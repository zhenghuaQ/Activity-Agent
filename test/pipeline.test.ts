import { describe, it, expect } from "vitest";
import { runFullPipeline } from "../src/planner/engine.js";
import { parseIntent } from "../src/intent/parser.js";
import { ALL_DIMENSIONS } from "../spec/decision.js";

// 端到端：用 Mock 解析器（确定性，不依赖 LLM/网络）跑完整 5 阶段，
// 校验 M2 决策产出（多维评分 / 帕累托 / 可解释 / 置信度）已正确装配。
describe("runFullPipeline 端到端决策", () => {
  it("产出带多维评分与帕累托方案的决策", async () => {
    const result = await runFullPipeline(
      "周末带老婆孩子下午出去玩4个小时，预算适中",
      parseIntent
    );

    expect(result.success).toBe(true);
    expect(result.agentState.status).toBe("completed");
    expect(result.agentState.runId).toBeTruthy();
    expect(result.agentState.sessionId).toBeTruthy();
    expect(result.agentState.traceId).toBeTruthy();
    expect(result.agentState.currentStep).toBe("fine_scheduling");
    expect(result.agentState.messages[0].kind).toBe("user_input");
    expect(result.agentState.messages.at(-1)?.kind).toBe("decision");
    expect(
      result.agentState.messages.filter((message) => message.kind === "tool_result").length
    ).toBe(result.agentState.toolCalls.length);
    expect(result.agentState.planning).toBe(result.state);
    expect(result.state.searchPolicy?.radiusKm).toBe(
      result.state.constraints?.distance.maxKm,
    );
    expect(result.state.planRevision).toBe(0);

    const { decision, selectedPlan } = result.state;
    expect(decision).toBeDefined();
    expect(selectedPlan).toBeDefined();

    // 首推 = balanced
    expect(decision!.recommended.objective).toBe("balanced");
    expect(decision!.recommended.plan.id).toBe(selectedPlan!.id);

    // 帕累托至少 1 个，且都带目标标签
    expect(decision!.pareto.length).toBeGreaterThanOrEqual(1);
    for (const c of decision!.pareto) {
      expect(c.objective).toBeTruthy();
    }

    // 置信度在 0-1
    expect(decision!.confidence).toBeGreaterThan(0);
    expect(decision!.confidence).toBeLessThanOrEqual(1);
  });

  it("支持由调用方注入 run/session/trace 标识", async () => {
    const result = await runFullPipeline("朋友4人下午聚会逛展吃饭", parseIntent, {
      runId: "run_test_001",
      sessionId: "sess_test_001",
      traceId: "trace_test_001",
    });

    expect(result.success).toBe(true);
    expect(result.agentState.runId).toBe("run_test_001");
    expect(result.agentState.sessionId).toBe("sess_test_001");
    expect(result.agentState.traceId).toBe("trace_test_001");
    expect(result.agentState.input.rawText).toContain("朋友4人");
  });

  it("首推方案含完整 6 维评分与可解释", async () => {
    const result = await runFullPipeline("朋友4人下午聚会逛展吃饭", parseIntent);
    expect(result.success).toBe(true);

    const plan = result.state.selectedPlan!;
    expect(plan.score).toBeDefined();
    expect(plan.score!.total).toBeGreaterThanOrEqual(0);
    expect(plan.score!.total).toBeLessThanOrEqual(100);

    // 6 维齐全
    const dims = plan.score!.dimensions.map((d) => d.dimension).sort();
    expect(dims).toEqual([...ALL_DIMENSIONS].sort());

    // 权重归一（和≈1）
    const wSum = plan.score!.dimensions.reduce((s, d) => s + d.weight, 0);
    expect(wSum).toBeCloseTo(1, 2);

    // 可解释亮点非空
    expect(plan.explanation).toBeDefined();
    expect(plan.explanation!.highlights.length).toBeGreaterThan(0);
  });

  it("每个活动都回填了拥挤度预测", async () => {
    const result = await runFullPipeline("情侣周末下午约会拍照", parseIntent);
    expect(result.success).toBe(true);
    for (const act of result.state.selectedPlan!.activities) {
      expect(act.crowd).toBeDefined();
      expect(act.crowd!.confidence).toBeGreaterThan(0);
    }
  });
});
