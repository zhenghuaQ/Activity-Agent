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
  Place,
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
import type { PlaceCandidate, PlaceSearchRequest } from "../../spec/place-search.js";
import { createInitialSearchPolicy } from "./search-policy.js";
import { evaluatePlanHardConstraints } from "../constraints/engine.js";
import { buildEffectivePlanCompletenessRequirements } from "../constraints/plan-completeness.js";
import type { CandidateHardConstraintEvaluation } from "../../spec/constraints.js";
import { buildActivityPlanTemplate, resolvePlanSpecification, composePlanAssignments, getAssignedPlaces, searchRoleToPlanSlotRole } from "./plan-composition.js";
import type { PlanSlotRole, SlotAssignment } from "./plan-composition.js";

/** Candidate generation 的只读运行环境；位置唯一来源是 Runtime Environment。 */
export interface PlanningEnvironment {
  userLocation: ResolvedLocation;
}

function getStateCompletenessRequirements(state: PlanningState) {
  if (!state.constraints) return undefined;
  const resolved = state.resolvedPlanSpecification ?? resolvePlanSpecification(state.constraints.planSpecification);
  return state.planCompletenessRequirements
    ?? buildEffectivePlanCompletenessRequirements(buildActivityPlanTemplate(resolved), state.constraints);
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
  const resolvedPlanSpecification = state.resolvedPlanSpecification ?? resolvePlanSpecification(state.constraints.planSpecification);
  const activeTemplate = buildActivityPlanTemplate(resolvedPlanSpecification);
  if (resolvedPlanSpecification.activityCount.value > 1) {
    return {
      ...state,
      stage: "candidate_generation",
      resolvedPlanSpecification,
      planCompletenessRequirements: state.planCompletenessRequirements
        ?? buildEffectivePlanCompletenessRequirements(activeTemplate, state.constraints),
      candidates: [],
      planningNotes: [...(state.planningNotes ?? []), "MULTI_ACTIVITY_SEQUENCE_GAP: 缺少基于路线与行程成本的同类活动访问顺序规划；显式数量未降级"],
      errors: [...(state.errors ?? [])],
    };
  }
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
  const needsActivity = activeTemplate.slots.some(slot => slot.role === "activity" && slot.max > 0);
  const needsMeal = activeTemplate.slots.some(slot => slot.role === "meal" && slot.max > 0);
  const needsRest = activeTemplate.slots.some(slot => slot.role === "rest" && slot.max > 0);
  let attEsc: import("../decision/fallback.js").EscalationResult<PlaceCandidate> | undefined;
  if (needsActivity) {
  attEsc = await withSpatialRadiusEscalation(primaryRequest, async (request) => {
    const r = await (toolExecutor
      ? toolExecutor.execute<PlaceSearchRequest, { places: PlaceCandidate[] }>("search_places", request)
      : placeTool.execute(request));
    return r.status === "error" ? [] : (r.data as { places: PlaceCandidate[] }).places.filter((c: PlaceCandidate) => c.detail.type === "attraction");
  }, { minCount: 2, maxRadius: state.searchPolicy?.maxRadiusKm ?? state.constraints.distance.hardMaxKm ?? 30 });
  if (attEsc.note) planningNotes.push(`景点：${attEsc.note}`);
  if (attEsc && state.constraints.distance.hardMaxKm !== undefined
    && attEsc.radiusUsed >= state.constraints.distance.hardMaxKm && attEsc.items.length < 2) {
    planningNotes.push("SEARCH_RADIUS_HARD_CAP_REACHED: 景点检索已达到用户硬距离上限");
  }
  }

  const mealRequest: PlaceSearchRequest = { spatial, intent: {
    categories: ["restaurant"],
    dietaryRequirements: group.preferences.dietaryRestrictions.length > 0
      ? [...group.preferences.dietaryRestrictions]
      : undefined,
    preferredTags: group.preferences.dieting ? ["轻食", "低卡", "健康餐"] : undefined,
    filters: group.preferences.preferredCuisine && group.preferences.preferredCuisine.length > 0 ? { cuisines: group.preferences.preferredCuisine } : undefined,
  }};
  let restEsc: import("../decision/fallback.js").EscalationResult<PlaceCandidate> | undefined;
  if (needsMeal) {
  restEsc = await withSpatialRadiusEscalation(mealRequest, async (request) => {
    const r = await (toolExecutor
      ? toolExecutor.execute<PlaceSearchRequest, { places: PlaceCandidate[] }>("search_places", request)
      : placeTool.execute(request));
    return r.status === "error" ? [] : (r.data as { places: PlaceCandidate[] }).places.filter((c: PlaceCandidate) => c.detail.type === "restaurant");
  }, { minCount: 2, maxRadius: state.searchPolicy?.maxRadiusKm ?? state.constraints.distance.hardMaxKm ?? 30 });
  if (restEsc.note) planningNotes.push(`餐厅：${restEsc.note}`);
  if (restEsc && state.constraints.distance.hardMaxKm !== undefined
    && restEsc.radiusUsed >= state.constraints.distance.hardMaxKm && restEsc.items.length < 2) {
    planningNotes.push("SEARCH_RADIUS_HARD_CAP_REACHED: 餐厅检索已达到用户硬距离上限");
  }
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
  const breakResult = needsRest ? await (toolExecutor
    ? toolExecutor.execute<PlaceSearchRequest, { places: PlaceCandidate[] }>("search_places", restRequest)
    : placeTool.execute(restRequest)) : undefined;

  let attractions: Attraction[] = (attEsc?.items ?? []).map((candidate) => candidate.detail).filter((p): p is Attraction => p.type === "attraction");
  const restaurants: Restaurant[] = (restEsc?.items ?? []).map((candidate) => candidate.detail).filter((p): p is Restaurant => p.type === "restaurant");
  const breaks: BreakPlace[] = !breakResult || breakResult.status === "error" ? [] : (breakResult.data as { places: PlaceCandidate[] }).places.map((candidate: PlaceCandidate) => candidate.detail).filter((p): p is BreakPlace => p.type === "break");

  // L2 放宽过滤：景点仍为空则去掉人群标签再搜一次
  if (needsActivity && attractions.length === 0) {
    const relaxedInput: PlaceSearchRequest = { spatial, intent: { categories: ["attraction", "museum", "park", "gallery"] } };
    const relaxed = await (toolExecutor
      ? toolExecutor.execute<PlaceSearchRequest, { places: PlaceCandidate[] }>("search_places", relaxedInput)
      : placeTool.execute(relaxedInput));
    if (relaxed.status !== "error" && (relaxed.data as { places: PlaceCandidate[] }).places.length > 0) {
      attractions = (relaxed.data as { places: PlaceCandidate[] }).places.map((c: PlaceCandidate) => c.detail).filter((p): p is Attraction => p.type === "attraction");
      planningNotes.push("景点：已放宽人群标签过滤以补足候选");
    }
  }

  // Preserve retrieval policy exactly: rerank, then truncate each existing pool.
  const reRankedAttractions = rerankForScenario(attractions, group.scenario, group.leadRole);
  const topAttractions = reRankedAttractions.slice(0, 2);
  const topRestaurants = restaurants.slice(0, 2);
  const topBreak = breaks.slice(0, 1);

  const candidatePools = new Map<PlanSlotRole, readonly Place[]>();
  const addPool = (searchRole: string, places: readonly Place[]) => {
    const slotRole = searchRoleToPlanSlotRole(searchRole);
    if (slotRole) candidatePools.set(slotRole, places);
  };
  if (needsActivity) addPool("primary_activity", topAttractions);
  if (needsMeal) addPool("meal", topRestaurants);
  addPool("rest", topBreak);

  // The existing time-window rule controls whether the optional rest slot is
  // active; when active it remains mandatory if a topBreak candidate exists,
  // matching the previous generator's includeBreak behavior.
  const includeBreak = topBreak.length > 0 && timeWindow.durationHours > 4;
  const enabledSlotIds = new Set(activeTemplate.slots.filter(slot => slot.role !== "rest" || includeBreak).map(slot => slot.slotId));
  const requiredSlotIds = new Set(activeTemplate.slots.filter(slot => slot.min > 0 || (slot.role === "rest" && includeBreak)).map(slot => slot.slotId));
  const assignments = composePlanAssignments(activeTemplate, candidatePools, { enabledSlotIds, requiredSlotIds });

  const candidates: PlanCandidate[] = [];
  let planIdx = 0;

  for (const assignment of assignments) {
    const candidate = await assembleActivityPlan(assignment, {
      id: `plan_${planIdx + 1}`,
      scenario: group.scenario,
      leadRole,
      startTime: timeWindow.start,
      searchOrigin,
      deliveryItems,
    });
    if (!candidate) continue;
    planIdx++;
    candidates.push(candidate);
  }

  return {
    ...state,
    stage: "candidate_generation",
    resolvedPlanSpecification,
    searchPolicy: state.searchPolicy ?? createInitialSearchPolicy(state.constraints),
    resolvedSearchArea,
    planRevision: state.planRevision ?? 0,
    candidates,
    planningNotes,
    errors,
  };
}

/** Domain adapter from generic slot assignment into the existing Activity Plan model. */
async function assembleActivityPlan(
  assignment: SlotAssignment[],
  input: { id: string; scenario: Scenario; leadRole: LeadRole; startTime: string; searchOrigin: import("../../spec/types.js").GeoLocation; deliveryItems: DeliveryItem[] },
): Promise<PlanCandidate | undefined> {
  const places = getAssignedPlaces(assignment);
  const { activities, totalMinutes } = await scheduleActivities(places, input.startTime, input.searchOrigin);
  const totalHours = totalMinutes / 60;
  if (totalHours < 3 || totalHours > 7) return undefined;

  const deliveryName = input.deliveryItems.length > 0
    ? (input.deliveryItems.find(item => item.name.includes("花")) ?? input.deliveryItems[0]!).name
    : "";
  const deliveryNote = deliveryName ? ` + ${deliveryName}` : "";
  const plan: Plan = {
    id: input.id,
    scenario: input.scenario,
    leadRole: input.leadRole,
    activities,
    totalDurationHours: Math.round(totalHours * 10) / 10,
    totalTransitMinutes: activities.reduce((sum, item) => sum + (item.transitTo?.totalMinutes ?? 0), 0),
    feasibilityScore: 0,
    summary: places.map(place => place.name).join(" → ") + deliveryNote,
  };
  plan.feasibilityScore = calcFeasibilityScore(plan);
  return { plan, feasibilityScore: plan.feasibilityScore, reason: `推荐: ${plan.summary}` };
}

// ─── Stage 4: 可行性校验 ──────────────────────────────

export async function stage4_feasibilityCheck(
  state: PlanningState,
  toolExecutor?: ToolExecutor
): Promise<PlanningState> {
  const completenessRequirements = getStateCompletenessRequirements(state);
  if (!state.candidates || state.candidates.length === 0) {
    return { ...state, stage: "feasibility_check", planCompletenessRequirements: completenessRequirements, errors: [...(state.errors ?? []), "无候选方案可校验"] };
  }

  const availabilityTool = toolRegistry.get("check_attraction_availability");
  const restAvailTool = toolRegistry.get("check_restaurant_availability");

  const containsAttraction = state.candidates?.some(candidate => candidate.plan.activities.some(activity => activity.place.type === "attraction"));
  const containsRestaurant = state.candidates?.some(candidate => candidate.plan.activities.some(activity => activity.place.type === "restaurant"));
  if ((containsAttraction && !availabilityTool) || (containsRestaurant && !restAvailTool)) {
    return { ...state, stage: "feasibility_check", errors: ["校验Tool未注册"] };
  }

  const { group } = state.constraints!;
  const validCandidates: PlanCandidate[] = [];
  const candidateHardEvaluations: CandidateHardConstraintEvaluation[] = [];
  const rejectedCandidates: CandidateHardConstraintEvaluation[] = [];

  for (const cand of state.candidates) {
    const hardEvaluation = evaluatePlanHardConstraints(cand.plan, state.constraints!, completenessRequirements);
    const candidateEvaluation: CandidateHardConstraintEvaluation = {
      candidateId: cand.plan.id,
      planId: cand.plan.id,
      passed: hardEvaluation.passed,
      checks: hardEvaluation.checks,
      hardFailures: hardEvaluation.hardFailures,
    };
    candidateHardEvaluations.push(candidateEvaluation);
    if (!hardEvaluation.passed) {
      rejectedCandidates.push(candidateEvaluation);
      continue;
    }

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
          : availabilityTool!.execute(availabilityInput));
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
          : restAvailTool!.execute(restaurantAvailabilityInput));
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
    const allCandidatesRejectedByHardFeasibility = rejectedCandidates.length > 0
      && rejectedCandidates.length === state.candidates.length
      && (state.errors?.length ?? 0) === 0;
    return {
      ...state,
      stage: "feasibility_check",
      planCompletenessRequirements: completenessRequirements,
      errors: allCandidatesRejectedByHardFeasibility
        ? [...(state.errors ?? [])]
        : [...(state.errors ?? []), "所有候选方案均未通过硬约束或可用性检查"],
      candidates: [],
      candidateHardEvaluations,
      rejectedCandidates,
    };
  }

  return {
    ...state,
    stage: "feasibility_check",
    planCompletenessRequirements: completenessRequirements,
    candidates: rankCandidates(validCandidates),
    candidateHardEvaluations,
    rejectedCandidates,
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
    onDecisionTrace?: (input: { scoredCandidates: PlanCandidate[]; decision: import("../../spec/decision.js").DecisionResult }) => void;
  }
): Promise<PlanningState> {
  const completenessRequirements = getStateCompletenessRequirements(state);
  const sourceCandidates = state.candidates ?? [];
  const feasibleCandidates = sourceCandidates.filter((candidate) =>
    evaluatePlanHardConstraints(candidate.plan, state.constraints!, completenessRequirements).passed);
  if (feasibleCandidates.length === 0) {
    return {
      ...state,
      stage: "fine_scheduling",
      planCompletenessRequirements: completenessRequirements,
      candidates: [],
      errors: [...(state.errors ?? []), "无可选方案"],
    };
  }

  // 多维评分 + 情境调权 + 帕累托多方案
  const decision = await runDecision(feasibleCandidates, state.constraints!, {
    date: opts?.date,
    weather: opts?.weather,
    weightOverride: opts?.weightOverride,
    notes: state.planningNotes,
    environmentLocation: opts?.environmentLocation,
    planCompletenessRequirements: completenessRequirements,
  });

  if (!decision) {
    return {
      ...state,
      stage: "fine_scheduling",
      planCompletenessRequirements: completenessRequirements,
      errors: [...(state.errors ?? []), "决策引擎未产出方案"],
    };
  }

  try { opts?.onDecisionTrace?.({ scoredCandidates: feasibleCandidates, decision }); } catch { /* Observability must not affect a decision. */ }

  return {
    ...state,
    stage: "fine_scheduling",
    planCompletenessRequirements: completenessRequirements,
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

