import { DECISION_SCENARIOS } from "../decision/scenarios/cases.js";
import { createBeijingFixture } from "../decision/scenarios/fixtures/beijing.js";
import { createShanghaiFixture } from "../decision/scenarios/fixtures/shanghai.js";
import type { DecisionScenario } from "../decision/scenarios/schema.js";
import { haversineKm } from "../../src/core/geo.js";
import { stage4_feasibilityCheck, stage5_selectBest } from "../../src/planner/stages.js";
import { evaluatePlanHardConstraints } from "../../src/constraints/engine.js";
import { runScenarioManual } from "../decision/evaluators/conversation.js";
import type { DecisionScenarioExecutionInput } from "../decision/scenarios/schema.js";
import type { Activity, Plan, PlanCandidate } from "../../spec/types.js";
import { parseIntent } from "../../src/intent/parser.js";
import { runDecision } from "../../src/decision/index.js";
import { evaluatePlanDistancePreference } from "../../src/decision/distance-preference.js";
import { evaluatePlanGroupSuitability } from "../../src/decision/group-suitability.js";
import { getCanonicalPlanIdentity } from "../../src/decision/plan-identity.js";
import { evaluateRecommendedPlanPreferences } from "../decision/evaluators/conversation.js";
import { combineFixtures, environmentAt, runDiagnostic } from "./decision-audit.js";
import type { DiagnosticProbe, DiagnosticRun } from "./types.js";
import { runExplanationFidelityProbe } from "./explanation-probe.js";
import { runDecisionTraceProbe } from "./decision-trace-probe.js";
import { runPlanCompositionProbe } from "./plan-composition-probe.js";

const scenario = (id: string): DecisionScenario => {
  const found = DECISION_SCENARIOS.find(candidate => candidate.id === id);
  if (!found) throw new Error(`diagnostic_scenario_missing:${id}`);
  return found;
};

function searchPool(run: DiagnosticRun) {
  return [...new Set(run.searches.flatMap(search => search.returnedIds))].sort();
}

function selectedIds(run: DiagnosticRun) {
  return run.selectedPlan?.activities.map(place => place.id).sort() ?? [];
}

function pairProbe(id: string, category: DiagnosticProbe["category"], description: string, a: DiagnosticRun, b: DiagnosticRun, note: string): DiagnosticProbe {
  return {
    id, category, description, runs: [a, b], observation: note,
    changed: {
      searchPool: JSON.stringify(searchPool(a)) !== JSON.stringify(searchPool(b)),
      candidates: JSON.stringify(a.candidateIds) !== JSON.stringify(b.candidateIds),
      pareto: JSON.stringify(a.pareto) !== JSON.stringify(b.pareto),
      selectedPlan: JSON.stringify(selectedIds(a)) !== JSON.stringify(selectedIds(b)),
      score: JSON.stringify(a.selectedPlan?.score?.dimensions) !== JSON.stringify(b.selectedPlan?.score?.dimensions),
    },
  };
}

function mutatePreferences(patch: (preferences: import("../../spec/types.js").UserPreferences) => void) {
  return (constraints: import("../../spec/types.js").StructuredConstraints) => {
    patch(constraints.group.preferences);
    return constraints;
  };
}

export async function runDecisionQualityProbes(): Promise<{ probes: DiagnosticProbe[]; tieBreak: DiagnosticProbe; audits: Record<string, unknown> }> {
  const solo = scenario("solo_nearby");
  const correction = scenario("preference_correction");
  const irrelevant = scenario("irrelevant_information");
  const hardDistance = scenario("hard_distance_limit");

  const distanceA = await runDiagnostic({ label: "preferred-distance-3km", turns: ["周末和朋友在北京逛展"], environment: solo.environment,
    transformConstraints: constraints => { constraints.distance.preferredMaxKm = 3; return constraints; } });
  const distanceB = await runDiagnostic({ label: "preferred-distance-10km", turns: ["周末和朋友在北京逛展"], environment: solo.environment,
    transformConstraints: constraints => { constraints.distance.preferredMaxKm = 10; return constraints; } });
  const preferredDistance = pairProbe("preferred-distance", "preference", "仅改变 preferredMaxKm：3km vs 10km", distanceA, distanceB,
    "该字段改变初始搜索半径/候选召回，但 scorePlan、ObjectiveScorers 和 Pareto 均未直接读取该字段；最终变化如果存在，来自候选池改变而非显式距离偏好排序。");

  const cuisineA = await runDiagnostic({ label: "cuisine-japanese", turns: ["周末和朋友出去玩"], environment: solo.environment,
    transformConstraints: mutatePreferences(preferences => { preferences.preferredCuisine = ["日料"]; }) });
  const cuisineB = await runDiagnostic({ label: "cuisine-hotpot", turns: ["周末和朋友出去玩"], environment: solo.environment,
    transformConstraints: mutatePreferences(preferences => { preferences.preferredCuisine = ["火锅"]; }) });
  const cuisine = pairProbe("cuisine-preference", "preference", "只改变偏好菜系：日料 vs 火锅", cuisineA, cuisineB,
    "菜系被下推为 Search filters.cuisines（会排除其他菜系），并在 scorePreference 中对命中餐厅加分，因此既改变召回也能进入排名；它并非纯软排序偏好。");

  const dietaryFixture = structuredClone(solo.environment.data);
  const sourceRestaurant = dietaryFixture.restaurants[0];
  if (!sourceRestaurant) throw new Error("dietary_probe_requires_restaurant_fixture");
  const makeRestaurant = (id: string, supported: Array<"免海鲜" | "免辣">) => ({
    ...structuredClone(sourceRestaurant), id, name: id, dietaryOptions: true, supportedDietaryRestrictions: supported,
    unsupportedDietaryRestrictions: [],
  });
  const seafoodHigh = makeRestaurant("diag-seafood-high-generic", ["免辣"]);
  seafoodHigh.rating = 5;
  const seafoodValid = makeRestaurant("diag-seafood-lower-supported", ["免海鲜"]);
  seafoodValid.rating = 3.5;
  const seafoodFixture = { ...dietaryFixture, restaurants: [seafoodHigh, seafoodValid] };
  const seafoodEnvironment = { ...solo.environment, data: seafoodFixture };
  const dietA = await runDiagnostic({ label: "dietary-seafood-specific", turns: ["周末和朋友出去玩，不能吃海鲜"], environment: seafoodEnvironment });
  const spicyHigh = makeRestaurant("diag-spicy-high-generic", ["免海鲜"]);
  spicyHigh.rating = 5;
  const spicyValid = makeRestaurant("diag-spicy-lower-supported", ["免辣"]);
  spicyValid.rating = 3.5;
  const spicyFixture = { ...dietaryFixture, restaurants: [spicyHigh, spicyValid] };
  const spicyEnvironment = { ...solo.environment, data: spicyFixture };
  const dietB = await runDiagnostic({ label: "dietary-non-spicy-specific", turns: ["周末和朋友出去玩，不能吃辣"], environment: spicyEnvironment });
  const unknownFixture = { ...dietaryFixture, restaurants: dietaryFixture.restaurants.map(item => ({ ...item, dietaryOptions: true, supportedDietaryRestrictions: undefined, unsupportedDietaryRestrictions: undefined })) };
  const unknownEnvironment = { ...solo.environment, data: unknownFixture };
  const dietUnknown = await runDiagnostic({ label: "dietary-specific-support-unknown", turns: ["周末和朋友出去玩，不能吃海鲜"], environment: unknownEnvironment });
  const dietary = pairProbe("dietary-restriction", "hard_constraint", "具体忌口按餐厅逐项支持证据硬校验：免海鲜 / 免辣 / generic-only unknown", dietA, dietB,
    "诊断 fixture 中高评分餐厅仅支持另一项忌口、较低评分餐厅明确支持当前要求；选择应只落在明确支持项。另一个 generic-only fixture 用于验证 dietaryOptions=true 不会消除 unknown。完整证据见 audits.dietaryCompatibility。");
  const dietaryCompatibility = {
    canonicalSeafood: dietA.constraints?.group.preferences.dietaryRestrictions.includes("免海鲜") === true,
    canonicalNonSpicy: dietB.constraints?.group.preferences.dietaryRestrictions.includes("免辣") === true,
    seafoodSelectedIds: selectedIds(dietA),
    seafoodExpectedId: seafoodValid.id,
    nonSpicySelectedIds: selectedIds(dietB),
    nonSpicyExpectedId: spicyValid.id,
    genericOnlyRuntimeCompleted: dietUnknown.runtimeCompleted,
    genericOnlyTermination: dietUnknown.planningTermination,
    genericOnlyHasUnknownEvidence: dietUnknown.hardRejectedCandidates.some(candidate => candidate.failures.some(failure =>
      failure.dietaryEvidence?.some(evidence => evidence.status === "unknown" && evidence.requirement === "免海鲜"))),
    conjunctionPassesOnlyWithBoth: (await import("../../src/constraints/dietary.js")).evaluateRestaurantDietaryCompatibility(
      makeRestaurant("diag-conjunction", ["免海鲜", "免辣"]), ["免海鲜", "免辣"],
    ).passed,
    conjunctionRejectsPartial: !(await import("../../src/constraints/dietary.js")).evaluateRestaurantDietaryCompatibility(
      makeRestaurant("diag-conjunction-partial", ["免海鲜"]), ["免海鲜", "免辣"],
    ).passed,
    genericBooleanIgnored: !(await import("../../src/constraints/dietary.js")).evaluateRestaurantDietaryCompatibility(
      makeRestaurant("diag-generic-only", []), ["免海鲜"],
    ).passed,
  };

  const budgetA = await runDiagnostic({ label: "budget-low", turns: ["周末和朋友出去玩"], environment: solo.environment,
    transformConstraints: mutatePreferences(preferences => { preferences.budget = "low"; }) });
  const budgetB = await runDiagnostic({ label: "budget-high", turns: ["周末和朋友出去玩"], environment: solo.environment,
    transformConstraints: mutatePreferences(preferences => { preferences.budget = "high"; }) });
  const budget = pairProbe("budget", "preference", "只改变预算档：low vs high", budgetA, budgetB,
    "预算不改变 Place Search，但 scoreBudget 的目标值与 low 档权重会改变各方案的 budget 维度/总分，并可影响 balanced 与 budget_saver 代表方案。");

  const paceA = await runDiagnostic({ label: "pace-neutral", turns: ["周末和朋友出去玩"], environment: solo.environment });
  const paceB = await runDiagnostic({ label: "pace-slow", turns: ["周末和朋友出去玩，不要太赶"], environment: solo.environment });
  const pace = pairProbe("pace-extra-hint", "preference", "仅增加“不要太赶”这类 extraHints", paceA, paceB,
    "解析器会写入休闲慢游/少赶路 extraHints，但当前 Search、scorePlan 和 Pareto 不消费这些提示；本次 fixture 对照用于检查其是否意外通过解析改变其它核心字段。");

  const localA = await runDiagnostic({ label: "local-feature-none", turns: ["周末和朋友在北京逛展"], environment: solo.environment });
  const localB = await runDiagnostic({ label: "local-feature-request", turns: ["周末和朋友在北京逛展"], environment: solo.environment,
    transformConstraints: constraints => { constraints.extraHints.push("local_tea"); return constraints; } });
  const localFeature = pairProbe("local-feature-hint", "preference", "只向 extraHints 增加 local_tea 需求", localA, localB,
    "现有用户约束没有 typed local-feature preference；任意非空 localFeatures 会获得相同固定偏好分，用户指定的 local_tea extraHint 不会与候选 feature 对齐。");

  const groupA = await runDiagnostic({ label: "group-friends", turns: ["周末和朋友出去玩"], environment: solo.environment,
    transformConstraints: constraints => { constraints.group.scenario = "friends"; constraints.group.leadRole = "friends_group"; return constraints; } });
  const groupB = await runDiagnostic({ label: "group-kids", turns: ["周末和朋友出去玩"], environment: solo.environment,
    transformConstraints: constraints => { constraints.group.scenario = "family"; constraints.group.leadRole = "kids"; constraints.group.ageGroup.youngChildren = 1; constraints.group.ageGroup.adults = constraints.group.totalPeople - 1; return constraints; } });
  const group = pairProbe("group-suitability", "preference", "只改变同行场景/主导角色：朋友组 vs 亲子", groupA, groupB,
    "同行信息影响候选 crowdTags、茶歇 required tags 与景点启发式重排，但 global score 的 crowd 维度仅按预测拥挤级别评分，没有计算候选对目标人群标签的匹配程度。");

  const groupPlace = structuredClone(solo.environment.data.attractions[0]);
  const groupRestaurant = structuredClone(solo.environment.data.restaurants[0]);
  if (!groupPlace || !groupRestaurant) throw new Error("group_probe_requires_complete_fixture");
  const makeGroupPlan = (id: string, crowdTags: typeof groupPlace.crowdTags): Plan => {
    const place = { ...structuredClone(groupPlace), id: `diag-${id}`, name: `diag-${id}`, crowdTags, localFeatures: [], distanceKm: 4 };
    const restaurant = { ...structuredClone(groupRestaurant), id: `diag-${id}-meal`, name: `diag-${id}-meal`, crowdTags, tags: ["儿童友好", "亲子", "老年餐", "清淡"], localFeatures: [], distanceKm: 4 };
    const activities: Activity[] = [
      { order: 1, place, scheduledStart: "10:00", scheduledEnd: "11:00", status: "scheduled", transitTo: null },
      { order: 2, place: restaurant, scheduledStart: "11:15", scheduledEnd: "12:15", status: "scheduled", transitTo: null },
    ];
    return { id, scenario: "family", leadRole: "kids", activities, totalDurationHours: 2.25,
      totalTransitMinutes: 0, feasibilityScore: 100, summary: id };
  };
  const familyPlan = makeGroupPlan("family-option", ["family_kids", "kids"]);
  const friendsPlan = makeGroupPlan("friends-option", ["friends"]);
  const candidates: PlanCandidate[] = [familyPlan, friendsPlan].map(plan => ({ plan, feasibilityScore: 100, reason: "controlled group suitability probe" }));
  const familyConstraints = structuredClone(parseIntent("周末和孩子出游"));
  familyConstraints.group.scenario = "family";
  familyConstraints.group.leadRole = "kids";
  familyConstraints.group.ageGroup.youngChildren = 1;
  const friendsConstraints = structuredClone(familyConstraints);
  friendsConstraints.group.scenario = "friends";
  friendsConstraints.group.leadRole = "friends_group";
  friendsConstraints.group.ageGroup.youngChildren = 0;
  const controlledCandidates = structuredClone(candidates);
  const familyRunCandidates = structuredClone(controlledCandidates);
  const friendsRunCandidates = structuredClone(controlledCandidates);
  const runOptions = { date: new Date("2026-09-26T10:00:00Z"), weather: "clear" as const };
  const familyDecision = await runDecision(familyRunCandidates, familyConstraints, runOptions);
  const friendsDecision = await runDecision(friendsRunCandidates, friendsConstraints, runOptions);
  const preferenceScore = (plan: Plan | undefined) => plan?.score?.dimensions.find(dimension => dimension.dimension === "preference")?.score;
  const groupSuitability = {
    searchUsed: false,
    candidateIdsIdentical: JSON.stringify(controlledCandidates.map(candidate => candidate.plan.id)) === JSON.stringify(candidates.map(candidate => candidate.plan.id)),
    hardFeasibleBoth: controlledCandidates.every(candidate => evaluatePlanHardConstraints(candidate.plan, familyConstraints).passed)
      && controlledCandidates.every(candidate => evaluatePlanHardConstraints(candidate.plan, friendsConstraints).passed),
    canonicalIdentities: candidates.map(candidate => getCanonicalPlanIdentity(candidate.plan)).sort(),
    familyScores: candidates.map(candidate => ({ id: candidate.plan.id, score: evaluatePlanGroupSuitability(candidate.plan, familyConstraints).score })),
    friendsScores: candidates.map(candidate => ({ id: candidate.plan.id, score: evaluatePlanGroupSuitability(candidate.plan, friendsConstraints).score })),
    familyPreferenceScores: familyRunCandidates.map(candidate => ({ id: candidate.plan.id, score: preferenceScore(candidate.plan) })),
    friendsPreferenceScores: friendsRunCandidates.map(candidate => ({ id: candidate.plan.id, score: preferenceScore(candidate.plan) })),
    familySelectedIdentity: familyDecision ? getCanonicalPlanIdentity(familyDecision.recommended.plan) : undefined,
    friendsSelectedIdentity: friendsDecision ? getCanonicalPlanIdentity(friendsDecision.recommended.plan) : undefined,
    selectedPlanChanged: familyDecision?.recommended.plan.id !== friendsDecision?.recommended.plan.id,
    groupContextOnlyChanged: true,
  };

  const hardA = await runDiagnostic({ label: "hard-distance-10km", turns: ["周末和朋友在北京逛展"], environment: hardDistance.environment,
    transformConstraints: constraints => { constraints.distance.hardMaxKm = 10; return constraints; } });
  const hardB = await runDiagnostic({ label: "hard-distance-1km", turns: ["周末和朋友在北京逛展"], environment: hardDistance.environment,
    transformConstraints: constraints => { constraints.distance.hardMaxKm = 1; return constraints; } });
  const hardDistanceProbe = pairProbe("hard-distance", "hard_constraint", "只改变 hardMaxKm：10km vs 1km", hardA, hardB,
    "硬距离限制搜索半径；Stage 4 现在还会对完整组合方案应用统一 hard-feasibility helper，排除越界候选并保留违规证据，再让可行方案进入评分。重规划搜索半径仍受用户 hardMaxKm 限制。");

  const beijingFixture = createBeijingFixture("Diag Beijing");
  const shanghaiFixture = createShanghaiFixture("Diag Shanghai");
  const combined = combineFixtures(beijingFixture, shanghaiFixture);
  const origin = beijingFixture.destinationCenters!.北京!;
  const destinationEnv = environmentAt(origin, combined);
  const destinationA = await runDiagnostic({ label: "destination-beijing", turns: ["周末去北京和朋友逛展"], environment: destinationEnv });
  const destinationB = await runDiagnostic({ label: "destination-shanghai", turns: ["周末去上海和朋友逛展"], environment: destinationEnv });
  const destination = pairProbe("destination", "hard_constraint", "只改变目的地：北京 vs 上海", destinationA, destinationB,
    "目的地解析后由 resolve_destination 决定 search origin；Stage 3 使用目的地中心检索，ConstraintEngine 只在最终选中 Plan 上验证城市，因此正常 Provider 空间契约是关键保护层。");

  const correctionRun = await runDiagnostic({ label: "preference-correction", turns: correction.turns.map(turn => turn.user), environment: correction.environment });
  const turn1 = correctionRun.turnSearches[0] ?? [];
  const turn2 = correctionRun.turnSearches[1] ?? [];
  const correctionBefore = correctionRun.turnSnapshots[0];
  const correctionAfter = correctionRun.turnSnapshots[correctionRun.turnSnapshots.length - 1];
  const correctionProbe: DiagnosticProbe = {
    id: "preference-correction",
    category: "correction",
    description: "Turn 1 日料；Turn 2 纠正为火锅",
    runs: [correctionRun],
    observation: `finalCuisine=${JSON.stringify(correctionRun.constraints?.group.preferences.preferredCuisine)}; turn1SearchCuisine=${JSON.stringify(turn1.find(search => search.categories.includes("restaurant"))?.cuisineFilter ?? [])}; turn2SearchCuisine=${JSON.stringify(turn2.find(search => search.categories.includes("restaurant"))?.cuisineFilter ?? [])}; selected=${JSON.stringify(selectedIds(correctionRun))}`,
    changed: {
      searchPool: JSON.stringify(turn1.flatMap(search => search.returnedIds).sort()) !== JSON.stringify(turn2.flatMap(search => search.returnedIds).sort()),
      candidates: JSON.stringify(correctionBefore?.selectedPlanIds) !== JSON.stringify(correctionAfter?.selectedPlanIds),
      pareto: JSON.stringify(correctionBefore?.pareto) !== JSON.stringify(correctionAfter?.pareto),
      selectedPlan: JSON.stringify(correctionBefore?.selectedPlanIds) !== JSON.stringify(correctionAfter?.selectedPlanIds),
      score: JSON.stringify(correctionBefore?.scoreDimensions) !== JSON.stringify(correctionAfter?.scoreDimensions),
    },
  };

  const irrelevantBefore = await runDiagnostic({ label: "irrelevant-before", turns: irrelevant.turns.slice(0, 1).map(turn => turn.user), environment: irrelevant.environment });
  const irrelevantAfter = await runDiagnostic({ label: "irrelevant-after", turns: irrelevant.turns.map(turn => turn.user), environment: irrelevant.environment });
  const irrelevantProbe = pairProbe("irrelevant-information", "robustness", "在同一会话追加“我最近换了手机”", irrelevantBefore, irrelevantAfter,
    "比较固定 Scenario 的第一轮与完整两轮执行；如果 final constraints/search pool/selection 变化，应追踪变化是否由无关 turn 的解析或 memory merge 引入。");

  const noFeasible = await runDiagnostic({ label: "hard-distance-limit-case", turns: hardDistance.turns.map(turn => turn.user), environment: hardDistance.environment });
  const availableFixturePlaces = [...hardDistance.environment.data.attractions, ...hardDistance.environment.data.restaurants, ...hardDistance.environment.data.breakPlaces];
  const withinHardLimit = availableFixturePlaces
    .map(place => ({ id: place.id, type: place.type, distanceKm: Math.round(haversineKm(hardDistance.environment.location.location, place.location) * 10) / 10 }))
    .filter(place => place.distanceKm <= (noFeasible.constraints?.distance.hardMaxKm ?? 0));
  const planWindow = await runDiagnostic({ label: "two-hour-window", turns: ["周末和朋友出去玩，我只有2小时"], environment: hardDistance.environment });
  const noFeasibleAudit = {
    scenarioId: hardDistance.id,
    constraints: noFeasible.constraints?.distance,
    searches: noFeasible.searches.map(search => ({ categories: search.categories, radiusKm: search.radiusKm, count: search.returnedIds.length, returnedIds: search.returnedIds })),
    selectedPlan: noFeasible.selectedPlan,
    planningTermination: noFeasible.planningTermination,
    runtimeCompleted: noFeasible.runtimeCompleted,
    runtimeErrors: noFeasible.runtimeErrors,
    completeFixturePlaceCount: availableFixturePlaces.length,
    fixturePlacesWithinHardLimit: withinHardLimit,
    classification: withinHardLimit.length === 0 ? "true_infeasibility" as const
      : noFeasible.searches.some(search => search.categories.includes("attraction") && search.returnedIds.length === 0) ? "retrieval_failure" as const
        : "planner_model_failure" as const,
    scope: "true_infeasibility is only established relative to the complete local deterministic fixture; it is not a claim about the real city/provider catalog.",
  };
  const hardGateAudit = await probeCandidateHardFilter(solo);
  const replanAudit = {
    observedReplans: noFeasible.replanCount,
    behavior: "Runtime Replanner 只因 within_distance 失败扩半径；searchPolicy 扩大只改 radiusKm，不改 StructuredConstraints。硬距离上限作为 maxRadius cap；当前 MockProvider 严守空间半径，因此固定 benchmark 没有形成可触发的越界重规划样例。",
    userPreferenceRetentionEvidence: "applyReplanPatch 保留 planning.constraints、followUpQuestions、planningNotes、resolvedSearchArea；candidate/score 重新生成。",
    preferenceDecisionRisk: "保留字段不等于偏好影响选择；preferredCuisine 可重搜，preferredMaxKm 仅是候选半径，预算/菜系等通过约束仍保留。",
  };
  const schemaAudit = {
    selectedPlan: planWindow.selectedPlan,
    requestedWindow: planWindow.constraints?.timeWindow,
    hardMaxDurationMinutes: planWindow.constraints?.hardMaxDurationMinutes,
    generatedPlanDurationHours: planWindow.selectedPlan?.totalDurationHours,
    temporalHardRejectedCandidates: planWindow.hardRejectedCandidates.filter(candidate =>
      candidate.failures.some(failure => failure.rule === "within_requested_duration")),
    temporalFailureEvidence: planWindow.hardRejectedCandidates.flatMap(candidate => candidate.failures)
      .filter(failure => failure.rule === "within_requested_duration"),
    selectedPlanWithinHardDuration: planWindow.selectedPlan
      ? planWindow.hardMaxDurationMinutes === undefined
        || planWindow.selectedPlan.totalDurationHours * 60 <= planWindow.hardMaxDurationMinutes
      : null,
    planningTermination: planWindow.planningTermination,
    runtimeCompleted: planWindow.runtimeCompleted,
    fixedRequirements: "默认 Plan completeness 仍要求 attraction/walking + restaurant；明确 mealPolicy=none 可跳过餐饮角色并 hard-enforce meal=0；elderly/mixed_family 仍要求 break。默认检索保留旧 limits；明确 activityCount>1 由 MULTI_ACTIVITY_SEQUENCE_GAP 阻止，不静默降级。",
    runtimeStatus: planWindow.runtimeStatus,
    runtimeErrors: planWindow.runtimeErrors,
  };
  const tieBreak = await runTieBreakProbe(solo);
  const distancePreference = await runDistancePreferenceSelectionProbe(solo);
  const recommendationPreference = runRecommendationPreferenceProbe(solo);
  const decisionTrace = await runDecisionTraceProbe();
  const planComposition = runPlanCompositionProbe();

  return {
    probes: [preferredDistance, cuisine, dietary, budget, pace, localFeature, group, hardDistanceProbe, destination, correctionProbe, irrelevantProbe],
    tieBreak,
    audits: { replan: replanAudit, noFeasible: noFeasibleAudit, planSchema: schemaAudit, hardGate: hardGateAudit, dietaryCompatibility, distancePreference, recommendationPreference, groupSuitability, explanationFidelity: runExplanationFidelityProbe(), decisionTrace, planComposition, planCompleteness: { dq07PhaseBComplete: true, structuredCustomFailure: planComposition.customCompletenessEvidence, genericRule: planComposition.customCompletenessUsesGenericRule, defaultTemplateCompatibility: planComposition.defaultCompletenessSource } },
  };
}

function runRecommendationPreferenceProbe(scenarioCase: DecisionScenario): Record<string, unknown> {
  const constraints = structuredClone(parseIntent("周末和朋友出去玩"));
  constraints.group.leadRole = "partner";
  constraints.group.preferences.dietaryRestrictions = ["免海鲜"];
  constraints.distance.preferredMaxKm = 3;
  const buildPlan = (id: string, cuisine: string, distanceKm: number, tags: ("local_tea")[] = []): Plan => {
    const attraction = { ...structuredClone(scenarioCase.environment.data.attractions[0]!), id: `${id}-attraction`, distanceKm,
      localFeatures: tags };
    const restaurant = { ...structuredClone(scenarioCase.environment.data.restaurants[0]!), id: `${id}-restaurant`, cuisine, distanceKm,
      supportedDietaryRestrictions: ["免海鲜" as const], unsupportedDietaryRestrictions: [] };
    const activities: Activity[] = [
      { order: 1, place: attraction, scheduledStart: "14:00", scheduledEnd: "16:00", status: "scheduled" },
      { order: 2, place: restaurant, scheduledStart: "16:00", scheduledEnd: "18:00", status: "scheduled" },
    ];
    return { id, scenario: "friends", leadRole: "partner", activities, totalDurationHours: 4, totalTransitMinutes: 10, feasibilityScore: 90, summary: id };
  };
  const japaneseNear = buildPlan("diag-japanese-near", "日料", 2, ["local_tea"]);
  const japaneseNearNoTag = buildPlan("diag-japanese-near-no-tag", "日料", 2);
  const hotpotFar = buildPlan("diag-hotpot-far", "火锅", 6);
  const expected = { preferredCuisine: ["日料"], preferredMaxKm: 3, desiredTags: ["local_tea"], leadRole: "partner" as const };
  const evaluate = (selectedPlan: Plan, preferences: DecisionScenario["expectations"]["preferences"] = expected) => evaluateRecommendedPlanPreferences({
    expected: preferences,
    finalConstraints: constraints,
    selectedPlan,
    outcome: "feasible_plan",
  });
  const cuisineOnly = { preferredCuisine: ["日料"] };
  const selectedMiss = evaluate(hotpotFar, cuisineOnly);
  const selectedHit = evaluate(japaneseNear, cuisineOnly);
  const partialExpected = { preferredCuisine: ["日料"], preferredMaxKm: 3, desiredTags: ["local_tea"] };
  const partial = evaluate(japaneseNearNoTag, partialExpected);
  const noPreference = evaluateRecommendedPlanPreferences({ expected: {}, finalConstraints: constraints, selectedPlan: japaneseNear, outcome: "feasible_plan" });
  const noFeasible = evaluateRecommendedPlanPreferences({ expected, finalConstraints: constraints, outcome: "no_feasible_plan" });
  const runtimeFailure = evaluateRecommendedPlanPreferences({ expected, finalConstraints: constraints, outcome: "runtime_failure" });
  const missedFeasible = evaluateRecommendedPlanPreferences({ expected, finalConstraints: constraints, outcome: "missed_feasible_plan" });
  return {
    evaluatorVersion: "decision-evaluator-v1.0",
    selectionSource: "execution.selectedPlan",
    alternativeMetricRetained: false,
    selectedMissAlternativeHit: {
      recommendation: selectedMiss,
      legacyParetoAnyWouldPassCuisine: [japaneseNear].some(plan => plan.activities.some(activity => activity.place.type === "restaurant" && "cuisine" in activity.place && typeof activity.place.cuisine === "string" && activity.place.cuisine.includes("日料"))),
    },
    selectedHitAlternativeMiss: { recommendation: selectedHit, alternativeCuisineMisses: ![hotpotFar].some(plan => plan.activities.some(activity => activity.place.type === "restaurant" && "cuisine" in activity.place && typeof activity.place.cuisine === "string" && activity.place.cuisine.includes("日料"))) },
    multiPreferencePartial: { recommendation: partial, alternativeHasMissingTag: japaneseNear.activities.some(activity => activity.place.localFeatures.includes("local_tea")) },
    noPreference,
    noFeasible,
    runtimeFailure,
    missedFeasible,
  };
}

async function runDistancePreferenceSelectionProbe(scenarioCase: DecisionScenario): Promise<Record<string, unknown>> {
  const constraints = structuredClone(parseIntent("周末和朋友出去玩"));
  constraints.destination = { city: scenarioCase.environment.location.location.city };
  constraints.distance = { preferredMaxKm: 3, hardMaxKm: 10 };
  constraints.hardMaxDurationMinutes = 240;
  constraints.group.preferences.dietaryRestrictions = ["免海鲜"];

  const buildPlan = (id: string, distanceKm: number, restaurantPrice: number): Plan => {
    const attraction = { ...structuredClone(scenarioCase.environment.data.attractions[0]!), id: `${id}-attraction`, distanceKm, pricePerPerson: 80 };
    const restaurant = { ...structuredClone(scenarioCase.environment.data.restaurants[0]!), id: `${id}-restaurant`, distanceKm, pricePerPerson: restaurantPrice,
      supportedDietaryRestrictions: ["免海鲜" as const], unsupportedDietaryRestrictions: [] };
    const activities: Activity[] = [
      { order: 1, place: attraction, scheduledStart: "14:00", scheduledEnd: "16:00", status: "scheduled" },
      { order: 2, place: restaurant, scheduledStart: "16:00", scheduledEnd: "18:00", status: "scheduled" },
    ];
    return { id, scenario: constraints.group.scenario, leadRole: constraints.group.leadRole, activities,
      totalDurationHours: 4, totalTransitMinutes: 10, feasibilityScore: 90, summary: id };
  };
  const near = buildPlan("distance-near", 2, 130);
  const far = buildPlan("distance-far", 8, 100);
  const planCandidates = (): PlanCandidate[] => [near, far].map(plan => ({ plan: structuredClone(plan), feasibilityScore: 90, reason: plan.summary }));
  const candidateSetIdentities = [getCanonicalPlanIdentity(near), getCanonicalPlanIdentity(far)].sort();
  const candidatePlaceIds = [near, far].flatMap(plan => plan.activities.map(activity => activity.place.id)).sort();
  const hardFeasible = [near, far].every(plan => evaluatePlanHardConstraints(plan, constraints).passed);

  const narrowCandidates = planCandidates();
  const narrowResult = await runDecision(narrowCandidates, structuredClone(constraints), { date: new Date("2026-09-26T12:00:00.000Z"), weather: "clear" });
  const wideConstraints = structuredClone(constraints);
  wideConstraints.distance.preferredMaxKm = 10;
  const wideCandidates = planCandidates();
  const wideResult = await runDecision(wideCandidates, wideConstraints, { date: new Date("2026-09-26T12:00:00.000Z"), weather: "clear" });
  const preferenceScore = (candidates: PlanCandidate[], id: string) => candidates.find(candidate => candidate.plan.id === id)
    ?.plan.score?.dimensions.find(dimension => dimension.dimension === "preference")?.score;
  const noPreferred = structuredClone(constraints);
  noPreferred.distance.preferredMaxKm = undefined;
  const noPreferredCandidates = planCandidates();
  await runDecision(noPreferredCandidates, noPreferred, { date: new Date("2026-09-26T12:00:00.000Z"), weather: "clear" });

  const hardOnly = structuredClone(constraints);
  hardOnly.distance = { preferredMaxKm: 10, hardMaxKm: 5 };
  const hardViolationRejected = !evaluatePlanHardConstraints(far, hardOnly).passed;
  return {
    searchUsed: false,
    candidatePlaceIdsByRun: [candidatePlaceIds, [...candidatePlaceIds]],
    candidatePlanIdentitiesByRun: [candidateSetIdentities, [...candidateSetIdentities]],
    candidateSetIdentical: JSON.stringify(candidatePlaceIds) === JSON.stringify([...candidatePlaceIds])
      && JSON.stringify(candidateSetIdentities) === JSON.stringify([...candidateSetIdentities]),
    nearIdentity: getCanonicalPlanIdentity(near),
    farIdentity: getCanonicalPlanIdentity(far),
    hardFeasibleBoth: hardFeasible,
    hardViolationRejected,
    preferred3: {
      nearDistance: evaluatePlanDistancePreference(near, constraints),
      farDistance: evaluatePlanDistancePreference(far, constraints),
      nearPreferenceScore: preferenceScore(narrowCandidates, near.id),
      farPreferenceScore: preferenceScore(narrowCandidates, far.id),
      selectedIdentity: narrowResult ? getCanonicalPlanIdentity(narrowResult.recommended.plan) : undefined,
    },
    preferred10: {
      nearDistance: evaluatePlanDistancePreference(near, wideConstraints),
      farDistance: evaluatePlanDistancePreference(far, wideConstraints),
      nearPreferenceScore: preferenceScore(wideCandidates, near.id),
      farPreferenceScore: preferenceScore(wideCandidates, far.id),
      selectedIdentity: wideResult ? getCanonicalPlanIdentity(wideResult.recommended.plan) : undefined,
    },
    noPreferredScores: [preferenceScore(noPreferredCandidates, near.id), preferenceScore(noPreferredCandidates, far.id)],
  };
}

async function probeCandidateHardFilter(scenarioCase: DecisionScenario): Promise<Record<string, unknown>> {
  const input: DecisionScenarioExecutionInput = {
    id: scenarioCase.id,
    description: scenarioCase.description,
    domain: scenarioCase.domain,
    turns: [{ user: "周末和朋友在北京逛展" }],
    environment: structuredClone(scenarioCase.environment),
    tags: [...scenarioCase.tags],
  };
  const execution = await runScenarioManual(input);
  if (!execution.selectedPlan || !execution.finalConstraints) throw new Error("hard_gate_probe_requires_selected_plan");
  const constraints = structuredClone(execution.finalConstraints);
  constraints.distance.hardMaxKm = 0.1;
  const invalidCandidate: PlanCandidate = {
    plan: structuredClone(execution.selectedPlan),
    feasibilityScore: execution.selectedPlan.feasibilityScore,
    reason: "diagnostic candidate: intentionally violates hardMaxKm",
  };
  const validCandidate = structuredClone(invalidCandidate);
  validCandidate.plan.id = "diagnostic-valid-alternative";
  validCandidate.plan.activities = validCandidate.plan.activities.map(activity => ({
    ...activity,
    place: { ...activity.place, distanceKm: 0 },
  }));
  const invalidOnly = await stage4_feasibilityCheck({
    stage: "candidate_generation",
    constraints,
    candidates: [invalidCandidate],
    errors: [],
  });
  const mixed = await stage4_feasibilityCheck({
    stage: "candidate_generation",
    constraints,
    candidates: [invalidCandidate, validCandidate],
    errors: [],
  });
  const stage5 = await stage5_selectBest(mixed);
  const dietaryConstraints = structuredClone(execution.finalConstraints);
  dietaryConstraints.group.preferences.dietaryRestrictions = ["免海鲜"];
  const dietaryEvaluation = evaluatePlanHardConstraints(execution.selectedPlan, dietaryConstraints);
  return {
    probe: "candidate-level hard feasibility before scoring",
    injectedHardMaxKm: constraints.distance.hardMaxKm,
    invalidCandidateActivityDistancesKm: invalidCandidate.plan.activities.map(activity => activity.place.distanceKm),
    invalidOnlyStage4InputCandidates: 1,
    invalidOnlyStage4OutputCandidates: invalidOnly.candidates?.length ?? 0,
    invalidOnlyRejectedEvidence: invalidOnly.rejectedCandidates?.map(candidate => ({
      candidateId: candidate.candidateId,
      hardFailures: candidate.hardFailures.map(check => check.rule),
    })),
    mixedStage4InputCandidates: 2,
    mixedStage4OutputCandidateIds: mixed.candidates?.map(candidate => candidate.plan.id),
    mixedRejectedCandidateIds: mixed.rejectedCandidates?.map(candidate => candidate.candidateId),
    stage5ParetoCandidateIds: stage5.decision?.pareto.map(candidate => candidate.plan.id),
    stage5SelectedPlanId: stage5.selectedPlan?.id,
    existingDietaryHardRulePresent: dietaryEvaluation.checks.some(check => check.rule.toLowerCase().includes("dietary")),
    runtimeExecutionCompleted: execution.runtime.completed,
    runtimePlanningTermination: execution.planningTermination?.reason,
    interpretation: "Stage 4 now rejects the out-of-distance plan and retains its candidate ID plus violation evidence; the valid alternative alone reaches Stage 5 and Pareto. The current ConstraintEngine has no dietary check, so no new dietary semantics were introduced.",
  };
}

async function runTieBreakProbe(scenarioCase: DecisionScenario): Promise<DiagnosticProbe> {
  const fixture = structuredClone(scenarioCase.environment.data);
  const attractionA = structuredClone(fixture.attractions[0]!);
  const attractionB = structuredClone(attractionA);
  attractionA.id = "diag-equal-attraction-a";
  attractionB.id = "diag-equal-attraction-b";
  const restaurantA = structuredClone(fixture.restaurants[0]!);
  const restaurantB = structuredClone(restaurantA);
  restaurantA.id = "diag-equal-restaurant-a";
  restaurantB.id = "diag-equal-restaurant-b";
  const tieFixture = {
    ...fixture,
    attractions: [attractionA, attractionB],
    restaurants: [restaurantA, restaurantB],
    breakPlaces: [],
  };
  const reverseFixture = { ...tieFixture, attractions: [...tieFixture.attractions].reverse(), restaurants: [...tieFixture.restaurants].reverse() };
  const a = await runDiagnostic({ label: "equal-candidates-original-order", turns: ["周末和朋友出去玩"], environment: scenarioCase.environment, fixture: tieFixture });
  const b = await runDiagnostic({ label: "equal-candidates-reversed-order", turns: ["周末和朋友出去玩"], environment: scenarioCase.environment, fixture: reverseFixture });
  return pairProbe("tie-break-order", "robustness", "完全同分、同地点/元数据的候选仅反转 Provider 数组顺序", a, b,
    "同一组候选及评分仅反转 Provider 数组顺序；比较 canonical selected identity 与各 objective representative，任何变化都说明 tie-break 仍受 insertion order 影响。");
}
