import { describe, it, expect } from "vitest";
import type {
  Attraction,
  Restaurant,
  Activity,
  Plan,
  PlanCandidate,
  StructuredConstraints,
} from "../spec/types.js";
import type { DecisionContext } from "../spec/decision.js";
import { DEFAULT_WEIGHTS } from "../spec/decision.js";
import { scorePlan } from "../src/decision/score.js";
import { adjustWeights } from "../src/decision/context.js";
import { buildPareto } from "../src/decision/pareto.js";
import { explainPlan } from "../src/decision/explain.js";

const HOME = { lat: 39.995, lng: 116.47, address: "望京", city: "北京" };

function attr(id: string, price: number, rating: number): Attraction {
  return {
    id,
    name: id,
    type: "attraction",
    crowdTags: ["friends"],
    localFeatures: ["scenic_spot"],
    address: id,
    distanceKm: 2,
    location: { ...HOME, address: id },
    rating,
    pricePerPerson: price,
    durationMinutes: 120,
    indoor: false,
    availableSlots: [],
  };
}

function rest(id: string, price: number, rating: number, cuisine: string): Restaurant {
  return {
    id,
    name: id,
    type: "restaurant",
    crowdTags: ["friends"],
    localFeatures: [],
    address: id,
    distanceKm: 2,
    location: { ...HOME, address: id },
    rating,
    pricePerPerson: price,
    cuisine,
    tags: [],
    avgDurationMinutes: 80,
    hasQueue: false,
    queueCount: 0,
    dietaryOptions: true,
  };
}

function makePlan(
  id: string,
  places: (Attraction | Restaurant)[],
  totalTransitMinutes: number
): Plan {
  const activities: Activity[] = places.map((p, i) => ({
    order: i + 1,
    place: p,
    scheduledStart: `${14 + i * 2}:00`,
    scheduledEnd: `${15 + i * 2}:00`,
    status: "scheduled",
    transitTo: i === 0 ? null : undefined,
  }));
  return {
    id,
    scenario: "friends",
    leadRole: "friends_group",
    activities,
    totalDurationHours: places.length * 2,
    totalTransitMinutes,
    feasibilityScore: 90,
    summary: id,
  };
}

const constraints: StructuredConstraints = {
  group: {
    scenario: "friends",
    totalPeople: 4,
    maleCount: 2,
    femaleCount: 2,
    ageGroup: { youngChildren: 0, teens: 0, adults: 4, seniors: 0 },
    leadRole: "friends_group",
    preferences: {
      dieting: false,
      budget: "medium",
      dietaryRestrictions: [],
      preferredCuisine: ["云南菜"],
      inferredDietary: {
        lightDiet: false,
        kidsFriendly: false,
        lowCalorie: false,
        softFood: false,
        restrictions: [],
      },
    },
  },
  timeWindow: { start: "14:00", end: "18:00", durationHours: 4 },
  distance: { hardMaxKm: 15 },
  extraHints: [],
};

const context: DecisionContext = { isWeekend: false, weather: "clear", departureHour: 14 };

describe("scorePlan 多维评分", () => {
  it("返回 6 个维度、总分与置信度均在合理区间", () => {
    const plan = makePlan("p", [attr("a", 50, 4.5), rest("r", 90, 4.5, "粤菜")], 20);
    const s = scorePlan({ plan, constraints, context, weights: DEFAULT_WEIGHTS });
    expect(s.dimensions).toHaveLength(6);
    expect(s.total).toBeGreaterThanOrEqual(0);
    expect(s.total).toBeLessThanOrEqual(100);
    expect(s.confidence).toBeGreaterThan(0);
    expect(s.confidence).toBeLessThanOrEqual(1);
  });

  it("更便宜的方案预算维度得分更高", () => {
    const cheap = makePlan("cheap", [attr("a1", 20, 4.3), rest("r1", 60, 4.3, "粤菜")], 20);
    const pricey = makePlan("pricey", [attr("a2", 200, 4.3), rest("r2", 400, 4.3, "粤菜")], 20);
    const sc = scorePlan({ plan: cheap, constraints, context, weights: DEFAULT_WEIGHTS });
    const sp = scorePlan({ plan: pricey, constraints, context, weights: DEFAULT_WEIGHTS });
    const budCheap = sc.dimensions.find((d) => d.dimension === "budget")!.score;
    const budPricey = sp.dimensions.find((d) => d.dimension === "budget")!.score;
    expect(budCheap).toBeGreaterThan(budPricey);
  });

  it("命中偏好菜系提升偏好维度", () => {
    const matched = makePlan("m", [attr("a", 50, 4.3), rest("r", 90, 4.3, "云南菜")], 20);
    const other = makePlan("o", [attr("a", 50, 4.3), rest("r", 90, 4.3, "快餐")], 20);
    const sm = scorePlan({ plan: matched, constraints, context, weights: DEFAULT_WEIGHTS });
    const so = scorePlan({ plan: other, constraints, context, weights: DEFAULT_WEIGHTS });
    const pm = sm.dimensions.find((d) => d.dimension === "preference")!.score;
    const po = so.dimensions.find((d) => d.dimension === "preference")!.score;
    expect(pm).toBeGreaterThan(po);
  });

  it("回填 activity.crowd", () => {
    const plan = makePlan("p", [attr("a", 50, 4.5), rest("r", 90, 4.5, "粤菜")], 20);
    scorePlan({ plan, constraints, context, weights: DEFAULT_WEIGHTS });
    expect(plan.activities[0].crowd).toBeDefined();
    expect(plan.activities[0].crowd!.confidence).toBeGreaterThan(0);
  });
});

describe("adjustWeights 情境调权", () => {
  it("周末抬高人群适配权重（归一化后仍更大）", () => {
    const base = adjustWeights(DEFAULT_WEIGHTS, context, constraints).weights;
    const weekend = adjustWeights(
      DEFAULT_WEIGHTS,
      { ...context, isWeekend: true },
      constraints
    ).weights;
    expect(weekend.crowd).toBeGreaterThan(base.crowd);
  });

  it("权重归一化后和为 1", () => {
    const { weights } = adjustWeights(DEFAULT_WEIGHTS, context, constraints);
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 5);
  });
});

describe("buildPareto 多目标方案", () => {
  it("省钱目标命中更便宜方案、体验目标命中高口碑方案", () => {
    const cheap = makePlan("cheap", [attr("a1", 20, 4.0), rest("r1", 50, 4.0, "快餐")], 15);
    const fancy = makePlan("fancy", [attr("a2", 150, 4.9), rest("r2", 300, 4.9, "云南菜")], 40);
    const cands: PlanCandidate[] = [
      { plan: cheap, feasibilityScore: 90, reason: "" },
      { plan: fancy, feasibilityScore: 90, reason: "" },
    ];
    for (const c of cands) {
      c.plan.score = scorePlan({ plan: c.plan, constraints, context, weights: DEFAULT_WEIGHTS });
    }
    const result = buildPareto(cands)!;
    expect(result).not.toBeNull();
    expect(result.recommended.objective).toBe("balanced");

    const budgetCand = result.pareto.find((c) => c.objective === "budget_saver");
    if (budgetCand) expect(budgetCand.plan.id).toBe("cheap");
    const expCand = result.pareto.find((c) => c.objective === "experience");
    if (expCand) expect(expCand.plan.id).toBe("fancy");
  });
});

describe("explainPlan 可解释", () => {
  it("生成非空亮点", () => {
    const plan = makePlan("p", [attr("a", 30, 4.8), rest("r", 80, 4.8, "云南菜")], 10);
    const s = scorePlan({ plan, constraints, context, weights: DEFAULT_WEIGHTS });
    const exp = explainPlan(s);
    expect(exp.highlights.length).toBeGreaterThan(0);
  });
});
