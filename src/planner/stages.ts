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
import type { ResolvedLocation } from "../../spec/location.js";
import { calcFeasibilityScore, rankCandidates } from "../decision/feasibility.js";
import { LeadRoleStrategy } from "../../spec/types.js";
import { toolRegistry } from "../tools/registry.js";
import { ToolExecutor } from "../runtime/tool-executor.js";
import { parseIntentWithLLM } from "../llm/intent.js";
import { DELIVERY_ITEMS } from "../data/mock.js";
import type { DeliveryItem } from "../../spec/types.js";
import { scheduleActivities } from "./scheduler.js";
import { filterWithinRadius } from "../core/geo.js";
import { runDecision, withSpatialRadiusEscalation } from "../decision/index.js";
import type { SearchArea } from "../../spec/datasource.js";
import type { PlaceCandidate, PlaceSearchRequest, PlaceSearchTask } from "../../spec/place-search.js";
import { createInitialSearchPolicy } from "./search-policy.js";

/** Candidate generation 的只读运行环境；位置唯一来源是 Runtime Environment。 */
export interface PlanningEnvironment {
  userLocation: ResolvedLocation;
}

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
    return { ...state, stage: "follow_up_questions", constraints, followUpQuestions: [] };
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
  if (patches.dieting !== undefined) preferences.dieting = patches.dieting;
  preferences.inferredDietary = { ...preferences.inferredDietary,
    lowCalorie: preferences.dieting,
    lightDiet: preferences.dieting || preferences.dietaryRestrictions.includes("轻油盐"),
    softFood: preferences.dietaryRestrictions.includes("软食"),
    restrictions: [...preferences.dietaryRestrictions] };

  return {
    ...constraints,
    extraHints: patches.extraHints
      ? [...new Set([...constraints.extraHints, ...patches.extraHints])]
      : constraints.extraHints,
    group: { ...group, preferences },
  };
}

// ─── Stage 3: 候选方案生成 ───────────────────────────

export async function stage3_generateCandidates(
  state: PlanningState,
  toolExecutor?: ToolExecutor,
  environment?: PlanningEnvironment,
): Promise<PlanningState> {
  if (!state.constraints) {
    return { ...state, stage: "candidate_generation", errors: ["需要先执行 Stage 1"] };
  }

  const resolvedEnvironmentLocation = environment?.userLocation?.location;
  if (!resolvedEnvironmentLocation) {
    return {
      ...state,
      stage: "candidate_generation",
      candidates: [],
      errors: [...(state.errors ?? []), "Candidate generation requires resolved environment location"],
    };
  }

  const { group, timeWindow } = state.constraints;
  const searchRadiusKm = state.searchPolicy?.radiusKm ?? createInitialSearchPolicy(state.constraints).radiusKm;
  const leadRole = group.leadRole;
  const errors: string[] = [];
  const planningNotes: string[] = [];

  let resolvedSearchArea: SearchArea | undefined = state.resolvedSearchArea;
  if (state.constraints.destination && !resolvedSearchArea) {
    const resolver = toolRegistry.get("resolve_destination");
    if (!resolver) return { ...state, stage: "candidate_generation", candidates: [],
      errors: ["resolve_destination tool 未注册"] };
    const input = { destination: state.constraints.destination };
    const result = await (toolExecutor
      ? toolExecutor.execute<typeof input, SearchArea>("resolve_destination", input)
      : resolver.execute(input));
    if (result.status === "error") return { ...state, stage: "candidate_generation", candidates: [],
      errors: [`目的地不可用: ${result.errorInfo.message}`] };
    resolvedSearchArea = result.data;
  }
  // Invariant: destination center overrides the resolved user environment location.
  const searchOrigin = resolvedSearchArea?.center ?? resolvedEnvironmentLocation;
  const placeTool = toolRegistry.get("search_places");
  if (!placeTool) {
    return {
      ...state,
      stage: "candidate_generation",
      errors: ["Tool 未注册"],
    };
  }

  // 分级兜底：候选不足时自动扩检索半径（L1）
  const spatial = { origin: searchOrigin, maxKm: searchRadiusKm };
  const primaryRequest: PlaceSearchRequest = { spatial, intent: {
    categories: ["attraction", "museum", "park", "gallery"],
    preferredTags: [...getCrowdTagsForScenario(group.scenario, group.leadRole)],
  }};
  const searchTasks: PlaceSearchTask[] = [{ role: "primary_activity", request: primaryRequest }];
  const attEsc = await withSpatialRadiusEscalation(primaryRequest, async (request) => {
    const r = await (toolExecutor
      ? toolExecutor.execute<PlaceSearchRequest, { places: PlaceCandidate[] }>("search_places", request)
      : placeTool.execute(request));
    return r.status === "error" ? [] : (r.data as { places: PlaceCandidate[] }).places.filter((c: PlaceCandidate) => c.detail.type === "attraction");
  }, { minCount: 2, maxRadius: state.searchPolicy?.maxRadiusKm ?? state.constraints.distance.hardMaxKm ?? 30 });
  if (attEsc.note) planningNotes.push(`景点：${attEsc.note}`);
  if (state.constraints.distance.hardMaxKm !== undefined
    && attEsc.radiusUsed >= state.constraints.distance.hardMaxKm && attEsc.items.length < 2) {
    planningNotes.push("SEARCH_RADIUS_HARD_CAP_REACHED: 景点检索已达到用户硬距离上限");
  }

  const mealRequest: PlaceSearchRequest = { spatial, intent: {
    categories: ["restaurant"],
    requiredTags: group.preferences.dietaryRestrictions.length > 0 ? ["dietary_options"] : undefined,
    preferredTags: group.preferences.dieting ? ["轻食", "低卡", "健康餐"] : undefined,
    filters: group.preferences.preferredCuisine && group.preferences.preferredCuisine.length > 0 ? { cuisines: group.preferences.preferredCuisine } : undefined,
  }};
  searchTasks.push({ role: "meal", request: mealRequest });
  const restEsc = await withSpatialRadiusEscalation(mealRequest, async (request) => {
    const r = await (toolExecutor
      ? toolExecutor.execute<PlaceSearchRequest, { places: PlaceCandidate[] }>("search_places", request)
      : placeTool.execute(request));
    return r.status === "error" ? [] : (r.data as { places: PlaceCandidate[] }).places.filter((c: PlaceCandidate) => c.detail.type === "restaurant");
  }, { minCount: 2, maxRadius: state.searchPolicy?.maxRadiusKm ?? state.constraints.distance.hardMaxKm ?? 30 });
  if (restEsc.note) planningNotes.push(`餐厅：${restEsc.note}`);
  if (state.constraints.distance.hardMaxKm !== undefined
    && restEsc.radiusUsed >= state.constraints.distance.hardMaxKm && restEsc.items.length < 2) {
    planningNotes.push("SEARCH_RADIUS_HARD_CAP_REACHED: 餐厅检索已达到用户硬距离上限");
  }

  // 配送搜索（仅情侣场景自动附加配送，优先鲜花 > 蛋糕）
  let deliveryItems: DeliveryItem[] = [];
  if (group.scenario === "couple" && searchOrigin.city.includes("北京")) {
    deliveryItems = filterWithinRadius(searchOrigin, DELIVERY_ITEMS, searchRadiusKm);
  }

  const restRequest: PlaceSearchRequest = { spatial, intent: {
    categories: ["cafe", "tea_house", "bookstore", "dessert", "break"],
    preferredTags: [
      ...(group.ageGroup.seniors > 0 ? ["accessible"] : []),
      ...(group.ageGroup.youngChildren > 0 ? ["kids_friendly"] : []),
    ],
  }};
  searchTasks.push({ role: "rest", request: restRequest });
  const breakResult = await (toolExecutor
    ? toolExecutor.execute<PlaceSearchRequest, { places: PlaceCandidate[] }>("search_places", restRequest)
    : placeTool.execute(restRequest));

  let attractions: Attraction[] = attEsc.items.map((candidate) => candidate.detail).filter((p): p is Attraction => p.type === "attraction");
  const restaurants: Restaurant[] = restEsc.items.map((candidate) => candidate.detail).filter((p): p is Restaurant => p.type === "restaurant");
  const breaks: BreakPlace[] = breakResult.status === "error" ? [] : (breakResult.data as { places: PlaceCandidate[] }).places.map((candidate: PlaceCandidate) => candidate.detail).filter((p): p is BreakPlace => p.type === "break");

  // L2 放宽过滤：景点仍为空则去掉人群标签再搜一次
  if (attractions.length === 0) {
    const relaxedInput: PlaceSearchRequest = { spatial, intent: { categories: ["attraction", "museum", "park", "gallery"] } };
    const relaxed = await (toolExecutor
      ? toolExecutor.execute<PlaceSearchRequest, { places: PlaceCandidate[] }>("search_places", relaxedInput)
      : placeTool.execute(relaxedInput));
    if (relaxed.status !== "error" && (relaxed.data as { places: PlaceCandidate[] }).places.length > 0) {
      attractions = (relaxed.data as { places: PlaceCandidate[] }).places.map((c: PlaceCandidate) => c.detail).filter((p): p is Attraction => p.type === "attraction");
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
        searchOrigin
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
    searchPolicy: state.searchPolicy ?? createInitialSearchPolicy(state.constraints),
    resolvedSearchArea,
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
    return { ...state, stage: "feasibility_check", errors: [...(state.errors ?? []), "无候选方案可校验"] };
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
  opts?: {
    date?: Date;
    weather?: import("../../spec/decision.js").WeatherCondition;
    weightOverride?: Partial<import("../../spec/decision.js").ScoringWeights>;
    environmentLocation?: ResolvedLocation;
  }
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
    environmentLocation: opts?.environmentLocation,
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

