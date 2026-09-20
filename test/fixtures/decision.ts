import type { DecisionResponse } from "../../spec/decision-response.js";
import type { PlanCandidate } from "../../spec/types.js";

function candidate(id: string, name: string, objective: "balanced" | "experience"): PlanCandidate {
  return { objective, feasibilityScore: 90, reason: "符合需求", plan: {
    id, scenario: "family", leadRole: "kids", summary: name,
    totalDurationHours: 2, totalTransitMinutes: 10, feasibilityScore: 90,
    activities: [{ order: 1, status: "scheduled", scheduledStart: "14:00", scheduledEnd: "16:00", place: {
      id, name, type: "attraction", address: "测试地址", distanceKm: 1, rating: 4.5,
      crowdTags: [], localFeatures: [], location: { lat: 39.9, lng: 116.4, address: "测试地址", city: "北京" },
    } }],
    score: { total: 80, confidence: 0.8, dimensions: [{ dimension: "time", score: 80, weight: 1, weighted: 80, reason: "时间合适" }] },
    explanation: { highlights: ["时间合适"], tradeoffs: [] },
  } };
}

export function decisionFixture(): DecisionResponse {
  const recommended = candidate("a", "公园方案", "balanced");
  return { success: true, message: "完成", notes: [], selectedPlan: recommended.plan,
    decision: { recommended, pareto: [recommended, candidate("b", "展览方案", "experience")], confidence: 0.8, notes: [] } };
}
