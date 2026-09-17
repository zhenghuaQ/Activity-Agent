// ============================================================
// src/planner/stages.ts — 5阶段分层递进式「一键决策」引擎
//
// 产品定位：核心竞争力是「一键决策」，不做下单/预订/取号/支付。
// 流程终点为输出可解释的最优决策方案（selectedPlan）。
//
// Stage 1: intent_parsing      — LLM提取约束
// Stage 2: follow_up_questions — 追问确认（如需）
// Stage 3: candidate_generation — 搜索+生成候选方案
// Stage 4: feasibility_check   — 可行性校验+通勤估算
// Stage 5: fine_scheduling     — 精细编排+最优决策输出
// ============================================================

import type {
  CrowdTag,
  Scenario,
  Attraction,
  BreakPlace,
  FollowUpAnswer,
  FollowUpQuestion,
  LeadRole,
  Plan,
  PlanCandidate,
  PlanningState,
  Restaurant,
  StructuredConstraints,
} from "../../spec/types.js";
import { calcFeasibilityScore, rankCandidates } from "../decision/feasibility.js";
import { LeadRoleStrategy } from "../../spec/types.js";
import { toolRegistry } from "../tools/registry.js";
import { ToolExecutor } from "../runtime/tool-executor.js";
import { parseIntentWithLLM } from "../llm/intent.js";
import { DELIVERY_ITEMS } from "../data/mock.js";
import type { DeliveryItem } from "../../spec/types.js";
import { scheduleActivities, getBreakSubtype } from "./scheduler.js";
import { filterWithinRadius } from "../core/geo.js";
import { runDecision, withRadiusEscalation } from "../decision/index.js";

// ─── Stage 1: 意图解析 ──────────────────────────────

export async function stage1_parseIntent(
  state: PlanningState,
  rawText: string,
  parseFn?: (text: string) => StructuredConstraints,
  signal?: AbortSignal,
): Promise<PlanningState> {
  const constraints = parseFn
    ? parseFn(rawText)
    : await parseIntentWithLLM(rawText, signal);
  return {
    ...state,
    stage: "intent_parsing",
    constraints,
  };
}

// ─── Stage 2: 追问环节 ──────────────────────────────

export async function stage2_followUp(
  state: PlanningState,
  answers?: FollowUpAnswer[],
  toolExecutor?: ToolExecutor
): Promise<PlanningState> {
  if (!state.constraints) {
    return { ...state, stage: "follow_up_questions", errors: ["需要先执行 Stage 1"] };
  }

  // 应用回答修正约束
  let constraints = state.constraints;
  if (answers && answers.length > 0) {
    for (const ans of answers) {
      constraints = applyFollowUpPatch(constraints, ans);
    }
  }

  // 检查是否需要追问
  const strategy = LeadRoleStrategy[constraints.group.leadRole];
  if (!strategy.needsFollowUp) {
    return {
      ...state,
      stage: "follow_up_questions",
      constraints,
      followUpQuestions: [],
    };
  }

  // 生成追问
  const followUpTool = toolRegistry.get("generate_followup_questions");
  if (!followUpTool) {
    return {
      ...state,
      stage: "follow_up_questions",
      constraints,
      errors: ["generate_followup_questions tool 未注册"],
    };
  }

  const result = await (toolExecutor
    ? toolExecutor.execute<{ constraints: StructuredConstraints }, FollowUpQuestion[]>("generate_followup_questions", { constraints })
    : followUpTool.execute({ constraints }));
  if (result.status === "error") {
    return {
      ...state,
      stage: "follow_up_questions",
      constraints,
      errors: [`追问生成失败: ${result.errorInfo.message}`],
    };
  }

  return {
    ...state,
    stage: "follow_up_questions",
    constraints,
    followUpQuestions: result.data,
  };
}

/** 应用追问回答到约束 */
function applyFollowUpPatch(
  constraints: StructuredConstraints,
  answer: FollowUpAnswer
): StructuredConstraints {
  const patches = answer.patches;
  const group = { ...constraints.group };
  const preferences = { ...group.preferences };

  if (patches.leadRole) group.leadRole = patches.leadRole;
  if (patches.dietaryRestrictions) preferences.dietaryRestrictions = patches.dietaryRestrictions;
  if (patches.preferredCuisine) preferences.preferredCuisine = patches.preferredCuisine;
  if (patches.budget) preferences.budget = patches.budget;

  return {
    ...constraints,
    group: { ...group, preferences },
  };
}

// ─── Stage 3: 候选方案生成 ───────────────────────────

export async function stage3_generateCandidates(
  state: PlanningState,
  toolExecutor?: ToolExecutor
): Promise<PlanningState> {
  if (!state.constraints) {
    return { ...state, stage: "candidate_generation", errors: ["需要先执行 Stage 1"] };
  }

  const { group, timeWindow, distance } = state.constraints;
  const searchRadiusKm = state.searchPolicy?.radiusKm ?? distance.maxKm;
  const leadRole = group.leadRole;
  const errors: string[] = [];
  const planningNotes: string[] = [];

  // ── 并行搜索：景点 + 餐厅 + 茶歇 ──
  const attractionTool = toolRegistry.get("search_attractions");
  const restaurantTool = toolRegistry.get("search_restaurants");
  const breakTool = toolRegistry.get("search_break_places");

  if (!attractionTool || !restaurantTool || !breakTool) {
    return {
      ...state,
      stage: "candidate_generation",
      errors: ["Tool 未注册"],
    };
  }

  // 分级兜底：候选不足时自动扩检索半径（L1）
  const attEsc = await withRadiusEscalation(
    {
      crowdTags: getCrowdTagsForScenario(group.scenario, group.leadRole),
      timeWindow,
      distance: { maxKm: searchRadiusKm, homeLocation: distance.homeLocation },
    },
    async (inp): Promise<Attraction[]> => {
      const r = await (toolExecutor ? toolExecutor.execute<typeof inp, Attraction[]>("search_attractions", inp) : attractionTool.execute(inp));
      return r.status === "error" ? [] : r.data;
    },
    { minCount: 2 }
  );
  if (attEsc.note) planningNotes.push(`景点：${attEsc.note}`);

  const restEsc = await withRadiusEscalation(
    {
      group,
      timeWindow,
      distance: { maxKm: searchRadiusKm, homeLocation: distance.homeLocation },
      dietaryRestrictions: group.preferences.dietaryRestrictions,
      preferenceTags: group.preferences.dieting ? ["轻食", "低卡", "健康餐"] : undefined,
    },
    async (inp): Promise<Restaurant[]> => {
      const r = await (toolExecutor ? toolExecutor.execute<typeof inp, Restaurant[]>("search_restaurants", inp) : restaurantTool.execute(inp));
      return r.status === "error" ? [] : r.data;
    },
    { minCount: 2 }
  );
  if (restEsc.note) planningNotes.push(`餐厅：${restEsc.note}`);

  // 配送搜索（仅情侣场景自动附加配送，优先鲜花 > 蛋糕）
  let deliveryItems: DeliveryItem[] = [];
  if (group.scenario === "couple") {
    deliveryItems = filterWithinRadius(distance.homeLocation, DELIVERY_ITEMS, distance.maxKm);
  }

  const breakInput = {
    breakSubtype: getBreakSubtype(leadRole),
    hasElderly: group.ageGroup.seniors > 0,
    hasYoungChildren: group.ageGroup.youngChildren > 0,
    distance: { maxKm: searchRadiusKm, homeLocation: distance.homeLocation },
    afterTime: timeWindow.start,
  };
  const breakResult = await (toolExecutor
    ? toolExecutor.execute<typeof breakInput, BreakPlace[]>("search_break_places", breakInput)
    : breakTool.execute(breakInput));

  let attractions: Attraction[] = attEsc.items;
  const restaurants: Restaurant[] = restEsc.items;
  const breaks: BreakPlace[] = breakResult.status === "error" ? [] : breakResult.data;

  // L2 放宽过滤：景点仍为空则去掉人群标签再搜一次
  if (attractions.length === 0) {
    const relaxedInput = {
      crowdTags: [],
      timeWindow,
      distance: { maxKm: searchRadiusKm, homeLocation: distance.homeLocation },
    };
    const relaxed = await (toolExecutor
      ? toolExecutor.execute<typeof relaxedInput, Attraction[]>("search_attractions", relaxedInput)
      : attractionTool.execute(relaxedInput));
    if (relaxed.status !== "error" && relaxed.data.length > 0) {
      attractions = relaxed.data;
      planningNotes.push("景点：已放宽人群标签过滤以补足候选");
    }
  }

  // ── 组合方案：选 top-2 景点 × top-2 餐厅 × top-1 茶歇 ──
  // 场景感知重排序：为特定场景提升相关景点优先级
  const reRankedAttractions = rerankForScenario(attractions, group.scenario, group.leadRole);
  const topAttractions = reRankedAttractions.slice(0, 2);
  const topRestaurants = restaurants.slice(0, 2);
  const topBreak = breaks.slice(0, 1);

  const candidates: PlanCandidate[] = [];
  let planIdx = 0;

  for (const attr of topAttractions) {
    for (const rest of topRestaurants) {
      // 短行程(≤4h)不插入茶歇
      const includeBreak = topBreak.length > 0 && timeWindow.durationHours > 4;
      const places = includeBreak ? [attr, ...topBreak, rest] : [attr, rest];
      const { activities, totalMinutes } = await scheduleActivities(
        places,
        timeWindow.start,
        distance.homeLocation
      );

      // 检查总时长是否在窗口内
      const totalHours = totalMinutes / 60;
      if (totalHours < 3 || totalHours > 7) continue;

      const deliveryName = deliveryItems.length > 0
      ? (deliveryItems.find(d => d.name.includes("花")) ?? deliveryItems[0]).name
      : "";
      const deliveryNote = deliveryName ? ` + ${deliveryName}` : "";

      const plan: Plan = {
        id: `plan_${++planIdx}`,
        scenario: group.scenario,
        leadRole,
        activities,
        totalDurationHours: Math.round(totalHours * 10) / 10,
        totalTransitMinutes: activities.reduce(
          (sum, a) => sum + (a.transitTo?.totalMinutes ?? 0),
          0
        ),
        feasibilityScore: 0,
        summary: (includeBreak ? `${attr.name} → ${topBreak[0].name} → ${rest.name}` : `${attr.name} → ${rest.name}`) + deliveryNote,
      };

      plan.feasibilityScore = calcFeasibilityScore(plan);

      candidates.push({
        plan,
        feasibilityScore: plan.feasibilityScore,
        reason: `推荐: ${plan.summary}`,
      });
    }
  }

  return {
    ...state,
    stage: "candidate_generation",
    searchPolicy: state.searchPolicy ?? { radiusKm: searchRadiusKm },
    planRevision: state.planRevision ?? 0,
    candidates,
    planningNotes,
    errors,
  };
}

// ─── Stage 4: 可行性校验 ──────────────────────────────

export async function stage4_feasibilityCheck(
  state: PlanningState,
  toolExecutor?: ToolExecutor
): Promise<PlanningState> {
  if (!state.candidates || state.candidates.length === 0) {
    return { ...state, stage: "feasibility_check", errors: ["无候选方案可校验"] };
  }

  const availabilityTool = toolRegistry.get("check_attraction_availability");
  const restAvailTool = toolRegistry.get("check_restaurant_availability");

  if (!availabilityTool || !restAvailTool) {
    return { ...state, stage: "feasibility_check", errors: ["校验Tool未注册"] };
  }

  const { group } = state.constraints!;
  const validCandidates: PlanCandidate[] = [];

  for (const cand of state.candidates) {
    let allOk = true;

    // 对每个活动做可用性检查
    for (const act of cand.plan.activities) {
      if (act.place.type === "attraction") {
        const availabilityInput = {
          attractionId: act.place.id,
          arrivalTime: act.scheduledStart,
        };
        const res = await (toolExecutor
          ? toolExecutor.execute<typeof availabilityInput, { available: boolean }>("check_attraction_availability", availabilityInput)
          : availabilityTool.execute(availabilityInput));
        if (res.status !== "error" && !res.data.available) {
          allOk = false;
        }
      }

      if (act.place.type === "restaurant") {
        const restaurantAvailabilityInput = {
          restaurantId: act.place.id,
          diningTime: act.scheduledStart,
          partySize: group.totalPeople,
        };
        const res = await (toolExecutor
          ? toolExecutor.execute<typeof restaurantAvailabilityInput, { estimatedWaitMinutes: number }>("check_restaurant_availability", restaurantAvailabilityInput)
          : restAvailTool.execute(restaurantAvailabilityInput));
        if (res.status !== "error" && res.data.estimatedWaitMinutes > 30) {
          allOk = false;
        }
      }
    }

    // 重新计算可行性分
    cand.feasibilityScore = calcFeasibilityScore(cand.plan);

    if (allOk || cand.feasibilityScore > 40) {
      validCandidates.push(cand);
    }
  }

  if (validCandidates.length === 0) {
    return {
      ...state,
      stage: "feasibility_check",
      errors: [...(state.errors ?? []), "所有候选方案均无法满足可用性要求"],
      candidates: state.candidates,
    };
  }

  return {
    ...state,
    stage: "feasibility_check",
    candidates: rankCandidates(validCandidates),
  };
}

// ─── Stage 5: 多维决策 & 帕累托多方案 ──────────────────

export async function stage5_selectBest(
  state: PlanningState,
  opts?: { date?: Date; weather?: import("../../spec/decision.js").WeatherCondition; weightOverride?: Partial<import("../../spec/decision.js").ScoringWeights> }
): Promise<PlanningState> {
  if (!state.candidates || state.candidates.length === 0) {
    return {
      ...state,
      stage: "fine_scheduling",
      errors: [...(state.errors ?? []), "无可选方案"],
    };
  }

  // 多维评分 + 情境调权 + 帕累托多方案
  const decision = await runDecision(state.candidates, state.constraints!, {
    date: opts?.date,
    weather: opts?.weather,
    weightOverride: opts?.weightOverride,
    notes: state.planningNotes,
  });

  if (!decision) {
    return {
      ...state,
      stage: "fine_scheduling",
      errors: [...(state.errors ?? []), "决策引擎未产出方案"],
    };
  }

  return {
    ...state,
    stage: "fine_scheduling",
    decision,
    candidates: decision.pareto,
    selectedPlan: decision.recommended.plan,
  };
}


/** 根据场景和主导角色确定搜索标签 */
function getCrowdTagsForScenario(scenario: Scenario, leadRole: LeadRole): CrowdTag[] {
  switch (scenario) {
    case "family":
      if (leadRole === "kids") return ["family_kids", "family_mixed"];
      if (leadRole === "elderly") return ["family_elderly", "family_mixed"];
      return ["family_mixed"];
    case "couple":
      return ["couple", "friends"];
    case "friends":
      return ["friends", "couple"];
    case "solo":
      return ["friends", "couple"];
    default:
      return ["friends"];
  }
}

/** 场景感知重排序：提升与场景高度匹配的景点 */
function rerankForScenario(attractions: Attraction[], scenario: Scenario, leadRole: LeadRole): Attraction[] {
  return [...attractions].sort((a, b) => {
    let scoreA = a.rating;
    let scoreB = b.rating;

    // Couple 场景：优先 scenic_spot + couple 标签
    if (scenario === "couple") {
      if (a.localFeatures.includes("scenic_spot") && a.crowdTags.includes("couple")) scoreA += 0.5;
      if (b.localFeatures.includes("scenic_spot") && b.crowdTags.includes("couple")) scoreB += 0.5;
    }

    // Family elderly：优先 scenic_spot
    if (leadRole === "elderly" && scenario === "family") {
      if (a.localFeatures.includes("scenic_spot")) scoreA += 0.3;
      if (b.localFeatures.includes("scenic_spot")) scoreB += 0.3;
    }

    return scoreB - scoreA;
  });
}

