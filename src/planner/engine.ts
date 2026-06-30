// ============================================================
// src/planner/engine.ts — 5阶段分层递进式「一键决策」引擎
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
  LeadRole,
  Plan,
  PlanCandidate,
  PlanningState,
  Restaurant,
  StructuredConstraints,
} from "../../spec/types.js";
import { calcFeasibilityScore, rankCandidates } from "../decision/feasibility.js";
import { LeadRoleStrategy } from "../../spec/types.js";
import type {
  FollowUpResult,
  AttractionAvailabilityResult,
  RestaurantAvailabilityResult,
} from "../../spec/tool-data.js";
import { toolRegistry } from "../tools/registry.js";
import { parseIntentWithLLM } from "../llm/intent.js";
import { DELIVERY_ITEMS } from "../data/mock.js";
import type { DeliveryItem } from "../../spec/types.js";
import { scheduleActivities, getBreakSubtype } from "./scheduler.js";
import { filterWithinRadius } from "../core/geo.js";
import { runDecision, withRadiusEscalation } from "../decision/index.js";
import {
  applyProfileToConstraints,
  resolveWeights,
  inferSegment,
  createProfile,
} from "../profile/index.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("planner");

// ─── Stage 1: 意图解析 ──────────────────────────────

export async function stage1_parseIntent(
  state: PlanningState,
  rawText: string,
  parseFn?: (text: string) => StructuredConstraints
): Promise<PlanningState> {
  const constraints = parseFn ? parseFn(rawText) : await parseIntentWithLLM(rawText);
  return {
    ...state,
    stage: "intent_parsing",
    constraints,
  };
}

// ─── Stage 2: 追问环节 ──────────────────────────────

export async function stage2_followUp(
  state: PlanningState,
  answers?: FollowUpAnswer[]
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

  const result = await followUpTool.execute({ constraints });
  if (result.status === "failed") {
    return {
      ...state,
      stage: "follow_up_questions",
      constraints,
      errors: [`追问生成失败: ${result.error}`],
    };
  }

  return {
    ...state,
    stage: "follow_up_questions",
    constraints,
    followUpQuestions: result.data as FollowUpResult,
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
  state: PlanningState
): Promise<PlanningState> {
  if (!state.constraints) {
    return { ...state, stage: "candidate_generation", errors: ["需要先执行 Stage 1"] };
  }

  const { group, timeWindow, distance } = state.constraints;
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
      distance: { maxKm: distance.maxKm, homeLocation: distance.homeLocation },
    },
    async (inp): Promise<Attraction[]> => {
      const r = await attractionTool.execute(inp);
      return r.status === "ok" ? (r.data as Attraction[]) : [];
    },
    { minCount: 2 }
  );
  if (attEsc.note) planningNotes.push(`景点：${attEsc.note}`);

  const restEsc = await withRadiusEscalation(
    {
      group,
      timeWindow,
      distance: { maxKm: distance.maxKm, homeLocation: distance.homeLocation },
      dietaryRestrictions: group.preferences.dietaryRestrictions,
      preferenceTags: group.preferences.dieting ? ["轻食", "低卡", "健康餐"] : undefined,
    },
    async (inp): Promise<Restaurant[]> => {
      const r = await restaurantTool.execute(inp);
      return r.status === "ok" ? (r.data as Restaurant[]) : [];
    },
    { minCount: 2 }
  );
  if (restEsc.note) planningNotes.push(`餐厅：${restEsc.note}`);

  // 配送搜索（仅情侣场景自动附加配送，优先鲜花 > 蛋糕）
  let deliveryItems: DeliveryItem[] = [];
  if (group.scenario === "couple") {
    deliveryItems = filterWithinRadius(distance.homeLocation, DELIVERY_ITEMS, distance.maxKm);
  }

  const breakResult = await breakTool.execute({
    breakSubtype: getBreakSubtype(leadRole),
    hasElderly: group.ageGroup.seniors > 0,
    hasYoungChildren: group.ageGroup.youngChildren > 0,
    distance: { maxKm: distance.maxKm, homeLocation: distance.homeLocation },
    afterTime: timeWindow.start,
  });

  let attractions: Attraction[] = attEsc.items;
  const restaurants: Restaurant[] = restEsc.items;
  const breaks: BreakPlace[] = breakResult.status === "ok" ? (breakResult.data as BreakPlace[]) : [];

  // L2 放宽过滤：景点仍为空则去掉人群标签再搜一次
  if (attractions.length === 0) {
    const relaxed = await attractionTool.execute({
      crowdTags: [],
      timeWindow,
      distance: { maxKm: attEsc.radiusUsed, homeLocation: distance.homeLocation },
    });
    if (relaxed.status === "ok" && (relaxed.data as Attraction[]).length > 0) {
      attractions = relaxed.data as Attraction[];
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
    candidates,
    planningNotes,
    errors,
  };
}

// ─── Stage 4: 可行性校验 ──────────────────────────────

export async function stage4_feasibilityCheck(
  state: PlanningState
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
        const res = await availabilityTool.execute({
          attractionId: act.place.id,
          arrivalTime: act.scheduledStart,
        });
        if (res.status !== "failed" && !(res.data as AttractionAvailabilityResult).available) {
          allOk = false;
        }
      }

      if (act.place.type === "restaurant") {
        const res = await restAvailTool.execute({
          restaurantId: act.place.id,
          diningTime: act.scheduledStart,
          partySize: group.totalPeople,
        });
        if (res.status !== "failed" && (res.data as RestaurantAvailabilityResult).estimatedWaitMinutes > 30) {
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

// ─── 总控：完整规划流程 ────────────────────────────────

export interface PlanResult {
  success: boolean;
  state: PlanningState;
  message: string;
}

export interface PipelineOptions {
  /** 显式用户画像（提供则应用其偏好与权重） */
  profile?: import("../../spec/profile.js").UserProfile;
  /** 无显式画像时，按约束自动推断分层并套用其权重先验 */
  autoSegment?: boolean;
  /** 覆盖天气 / 参考日期（情境调权用） */
  weather?: import("../../spec/decision.js").WeatherCondition;
  date?: Date;
}

export async function runFullPipeline(
  rawText: string,
  parseFn?: (text: string) => StructuredConstraints,
  opts: PipelineOptions = {}
): Promise<PlanResult> {
  let state: PlanningState = { stage: "intent_parsing", errors: [] };

  try {
    // Stage 1
    state = await stage1_parseIntent(state, rawText, parseFn!);

    // 个性化：应用画像偏好到约束，并解析权重覆盖
    const weightOverride = applyPersonalization(state, opts);
    log.info({ leadRole: state.constraints!.group.leadRole }, "[Stage 1] 意图解析");

    // Stage 2
    state = await stage2_followUp(state);
    const followUps = state.followUpQuestions?.length ?? 0;
    log.info({ followUps }, "[Stage 2] 追问环节");

    // Stage 3
    state = await stage3_generateCandidates(state);
    log.info({ candidates: state.candidates?.length ?? 0 }, "[Stage 3] 候选生成");

    // Stage 4
    state = await stage4_feasibilityCheck(state);
    log.info({ feasible: state.candidates?.length ?? 0 }, "[Stage 4] 可行性校验");

    // Stage 5
    state = await stage5_selectBest(state, {
      weightOverride,
      weather: opts.weather,
      date: opts.date,
    });
    log.info(
      {
        selected: !!state.selectedPlan,
        objectives: state.decision?.pareto.map((c) => c.objective),
        confidence: state.decision?.confidence,
      },
      "[Stage 5] 多维决策"
    );

    if (state.selectedPlan) {
      return { success: true, state, message: "方案规划完成" };
    }

    return { success: false, state, message: "未能生成可行方案" };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "规划管线异常");
    return {
      success: false,
      state,
      message: `规划异常: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── 流式管线（SSE 用） ────────────────────────────────

export type PlanningStageName = import("../../spec/types.js").PlanningStage;

export interface StageEvent {
  stage: PlanningStageName;
  /** 第几步（1-based） */
  index: number;
  total: number;
  message: string;
  /** 该阶段的轻量摘要数据 */
  data?: Record<string, unknown>;
}

const STAGE_TITLES: Record<PlanningStageName, string> = {
  intent_parsing: "意图解析",
  follow_up_questions: "追问确认",
  candidate_generation: "候选生成",
  feasibility_check: "可行性校验",
  fine_scheduling: "多维决策",
};

/**
 * 与 runFullPipeline 等价，但每完成一个阶段就回调 onStage，
 * 供网关以 SSE 把决策过程实时推给前端看板。
 */
export async function runFullPipelineStreaming(
  rawText: string,
  parseFn: ((text: string) => StructuredConstraints) | undefined,
  opts: PipelineOptions = {},
  onStage?: (e: StageEvent) => void | Promise<void>
): Promise<PlanResult> {
  let state: PlanningState = { stage: "intent_parsing", errors: [] };
  const emit = async (stage: PlanningStageName, index: number, data?: Record<string, unknown>) => {
    if (onStage) await onStage({ stage, index, total: 5, message: STAGE_TITLES[stage], data });
  };

  try {
    state = await stage1_parseIntent(state, rawText, parseFn!);
    const weightOverride = applyPersonalization(state, opts);
    await emit("intent_parsing", 1, {
      scenario: state.constraints!.group.scenario,
      leadRole: state.constraints!.group.leadRole,
      people: state.constraints!.group.totalPeople,
    });

    state = await stage2_followUp(state);
    await emit("follow_up_questions", 2, {
      followUps: state.followUpQuestions?.length ?? 0,
    });

    state = await stage3_generateCandidates(state);
    await emit("candidate_generation", 3, {
      candidates: state.candidates?.length ?? 0,
      notes: state.planningNotes ?? [],
    });

    state = await stage4_feasibilityCheck(state);
    await emit("feasibility_check", 4, { feasible: state.candidates?.length ?? 0 });

    state = await stage5_selectBest(state, {
      weightOverride,
      weather: opts.weather,
      date: opts.date,
    });
    await emit("fine_scheduling", 5, {
      selected: !!state.selectedPlan,
      objectives: state.decision?.pareto.map((c) => c.objective) ?? [],
      confidence: state.decision?.confidence,
    });

    if (state.selectedPlan) return { success: true, state, message: "方案规划完成" };
    return { success: false, state, message: "未能生成可行方案" };
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, "规划管线异常");
    return {
      success: false,
      state,
      message: `规划异常: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── 辅助函数 ──────────────────────────────────────

/** 应用画像个性化到约束，返回权重覆盖（runFullPipeline 与流式版共用） */
function applyPersonalization(
  state: PlanningState,
  opts: PipelineOptions
): Partial<import("../../spec/decision.js").ScoringWeights> | undefined {
  if (opts.profile) {
    state.constraints = applyProfileToConstraints(state.constraints!, opts.profile);
    return resolveWeights(opts.profile);
  }
  if (opts.autoSegment) {
    const segment = inferSegment(state.constraints!);
    log.info({ segment }, "自动分层");
    return resolveWeights(createProfile({ id: "_auto", segment }));
  }
  return undefined;
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