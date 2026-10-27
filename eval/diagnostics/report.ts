import type { DecisionQualityAudit, DiagnosticProbe } from "./types.js";
import { INFLUENCE_MATRIX, PIPELINE, SCORE_FEATURES } from "./influence.js";
import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";

const probe = (probes: DiagnosticProbe[], id: string): DiagnosticProbe => {
  const result = probes.find(item => item.id === id);
  if (!result) throw new Error(`diagnostic_probe_missing:${id}`);
  return result;
};

function isDq05Closed(hardGate: Record<string, unknown>): boolean {
  return hardGate.invalidOnlyStage4OutputCandidates === 0
    && Array.isArray(hardGate.invalidOnlyRejectedEvidence)
    && Array.isArray(hardGate.mixedStage4OutputCandidateIds)
    && (hardGate.mixedStage4OutputCandidateIds as string[]).length === 1
    && Array.isArray(hardGate.stage5ParetoCandidateIds)
    && (hardGate.stage5ParetoCandidateIds as string[]).length === 1;
}

function isDq08Closed(schema: Record<string, unknown>): boolean {
  const failures = schema.temporalFailureEvidence;
  return schema.hardMaxDurationMinutes === 120
    && schema.runtimeCompleted === true
    && schema.planningTermination === "no_feasible_plan"
    && Array.isArray(schema.runtimeErrors)
    && schema.runtimeErrors.length === 0
    && Array.isArray(failures)
    && failures.length > 0
    && failures.every((failure) => failure && typeof failure === "object"
      && (failure as { rule?: unknown }).rule === "within_requested_duration")
    && schema.selectedPlan === undefined;
}

function isDq02Closed(dietary: Record<string, unknown>): boolean {
  const seafoodIds = dietary.seafoodSelectedIds;
  const spicyIds = dietary.nonSpicySelectedIds;
  return dietary.canonicalSeafood === true
    && dietary.canonicalNonSpicy === true
    && Array.isArray(seafoodIds) && seafoodIds.includes(dietary.seafoodExpectedId)
    && !seafoodIds.includes("diag-seafood-high-generic")
    && Array.isArray(spicyIds) && spicyIds.includes(dietary.nonSpicyExpectedId)
    && !spicyIds.includes("diag-spicy-high-generic")
    && dietary.genericOnlyRuntimeCompleted === true
    && dietary.genericOnlyTermination === "no_feasible_plan"
    && dietary.genericOnlyHasUnknownEvidence === true
    && dietary.conjunctionPassesOnlyWithBoth === true
    && dietary.conjunctionRejectsPartial === true
    && dietary.genericBooleanIgnored === true;
}

function isDq06Closed(tieBreak: DiagnosticProbe): boolean {
  if (!(tieBreak.runs.length === 2
    && tieBreak.runs.every(run => run.runtimeCompleted)
    && tieBreak.changed.searchPool === false
    && tieBreak.changed.candidates === false
    && tieBreak.changed.score === false
    && tieBreak.changed.selectedPlan === false
    && tieBreak.changed.pareto === false)) return false;

  return true;
}

function isDq01Closed(value: Record<string, unknown>): boolean {
  const preferred3 = value.preferred3 as Record<string, unknown> | undefined;
  const preferred10 = value.preferred10 as Record<string, unknown> | undefined;
  const noPreferredScores = value.noPreferredScores;
  return value.searchUsed === false
    && value.candidateSetIdentical === true
    && value.hardFeasibleBoth === true
    && value.hardViolationRejected === true
    && typeof value.nearIdentity === "string"
    && typeof value.farIdentity === "string"
    && Number(preferred3?.nearPreferenceScore) > Number(preferred3?.farPreferenceScore)
    && preferred3?.selectedIdentity === value.nearIdentity
    && preferred10?.nearPreferenceScore === preferred10?.farPreferenceScore
    && preferred10?.selectedIdentity === value.farIdentity
    && Array.isArray(noPreferredScores)
    && noPreferredScores.length === 2
    && noPreferredScores[0] === noPreferredScores[1];
}

function isDq11Closed(value: Record<string, unknown>): boolean {
  const missCase = value.selectedMissAlternativeHit as { recommendation?: Record<string, unknown>; legacyParetoAnyWouldPassCuisine?: unknown } | undefined;
  const hitCase = value.selectedHitAlternativeMiss as { recommendation?: Record<string, unknown>; alternativeCuisineMisses?: unknown } | undefined;
  const partialCase = value.multiPreferencePartial as { recommendation?: Record<string, unknown>; alternativeHasMissingTag?: unknown } | undefined;
  const miss = missCase?.recommendation;
  const hit = hitCase?.recommendation;
  const partial = partialCase?.recommendation;
  const na = (item: unknown, reason: string) => {
    const record = item as Record<string, unknown> | undefined;
    return record?.applicable === false && record.coverage === null && record.notApplicableReason === reason;
  };
  return value.evaluatorVersion === "decision-evaluator-v1.0"
    && value.selectionSource === "execution.selectedPlan"
    && value.alternativeMetricRetained === false
    && miss?.applicable === true && miss.satisfied === 0 && miss.total === 1 && miss.coverage === 0
    && missCase?.legacyParetoAnyWouldPassCuisine === true
    && hit?.applicable === true && hit.satisfied === 1 && hit.total === 1 && hit.coverage === 1
    && hitCase?.alternativeCuisineMisses === true
    && partial?.applicable === true && partial.satisfied === 2 && partial.total === 3 && partial.coverage === 2 / 3
    && partialCase?.alternativeHasMissingTag === true
    && na(value.noPreference, "no_preferences")
    && na(value.noFeasible, "no_feasible_plan")
    && na(value.runtimeFailure, "runtime_failure")
    && na(value.missedFeasible, "missed_feasible_plan");
}

function isDq04Closed(value: Record<string, unknown>): boolean {
  const evidence = value as {
    searchUsed?: unknown; candidateIdsIdentical?: unknown; hardFeasibleBoth?: unknown; selectedPlanChanged?: unknown;
    groupContextOnlyChanged?: unknown; canonicalIdentities?: unknown;
    familyScores?: Array<{ id?: string; score?: number }>;
    friendsScores?: Array<{ id?: string; score?: number }>;
    familyPreferenceScores?: Array<{ id?: string; score?: number }>;
    friendsPreferenceScores?: Array<{ id?: string; score?: number }>;
    familySelectedIdentity?: unknown; friendsSelectedIdentity?: unknown;
  };
  const byId = (items: Array<{ id?: string; score?: number }> | undefined, id: string) => items?.find(item => item.id === id)?.score;
  const familyA = byId(evidence.familyScores, "family-option");
  const familyB = byId(evidence.familyScores, "friends-option");
  const friendsA = byId(evidence.friendsScores, "family-option");
  const friendsB = byId(evidence.friendsScores, "friends-option");
  const prefFamilyA = byId(evidence.familyPreferenceScores, "family-option");
  const prefFamilyB = byId(evidence.familyPreferenceScores, "friends-option");
  const prefFriendsA = byId(evidence.friendsPreferenceScores, "family-option");
  const prefFriendsB = byId(evidence.friendsPreferenceScores, "friends-option");
  return evidence.searchUsed === false
    && evidence.candidateIdsIdentical === true
    && evidence.hardFeasibleBoth === true
    && evidence.groupContextOnlyChanged === true
    && evidence.selectedPlanChanged === true
    && Array.isArray(evidence.canonicalIdentities) && evidence.canonicalIdentities.length === 2
    && Number(familyA) > Number(familyB) && Number(friendsB) > Number(friendsA)
    && Number(prefFamilyA) > Number(prefFamilyB) && Number(prefFriendsB) > Number(prefFriendsA)
    && evidence.familySelectedIdentity !== evidence.friendsSelectedIdentity;
}

function isDq09Closed(value: Record<string, unknown>): boolean {
  const required = [
    "localMismatchRejected", "localMatchAccepted", "noRequestNotPreferenceClaim",
    "cuisineMissRejected", "cuisineHitAccepted", "distanceHitAccepted", "distanceMissRejected",
    "hardDistanceNotSoft", "dietarySupportedVerified", "dietaryUnknownNotVerified", "genericDietaryNotVerified",
    "groupMismatchRejected", "groupMatchAccepted", "hardDurationSurfaced", "dietaryUnknownUsesUncertainty",
    "dietaryUnsupportedNotClaimedAsUnknown", "infrastructureFailureDistinct", "stableEvidenceOrder",
    "hardDurationNoFeasibleSpecific", "alternativeIndependent", "noMutation", "numericScoreUnchanged", "maxHighlights",
  ];
  return required.every(key => value[key] === true);
}

function isDq10Closed(value: Record<string, unknown>): boolean {
  const noFeasible = value.noFeasible as Record<string, unknown> | undefined;
  const runtimeFailure = value.runtimeFailure as Record<string, unknown> | undefined;
  return value.version === "decision-trace-v1"
    && value.candidateCount === 3
    && value.hardRejectedCount === 1
    && Array.isArray(value.rejectedCodes) && value.rejectedCodes.includes("within_distance")
    && value.scoredCount === 2 && value.rejectedNotScored === true
    && value.recommendedIsC === true && value.recommendedScoreHigherThanB === true
    && Array.isArray(value.objectives) && value.objectives.length === 4
    && value.finalAcceptancePassed === true && value.selectedIsRecommended === true
    && (value.termination as { reason?: unknown } | undefined)?.reason === "plan_selected"
    && value.explanationBelongsToSelected === true
    && (value.fallback as Record<string, unknown> | undefined)?.recommendedIsC === true
    && (value.fallback as Record<string, unknown> | undefined)?.finalSelectedIsAlternate === true
    && (value.fallback as Record<string, unknown> | undefined)?.fallbackUsed === true
    && Array.isArray((value.fallback as Record<string, unknown> | undefined)?.failureCodes)
    && Array.isArray(value.invariantViolations) && value.invariantViolations.length === 0
    && value.candidateOrderStable === true && value.privacySafe === true
    && noFeasible?.candidateCount === 2 && noFeasible.rejectedCount === 2
    && noFeasible.scoredCount === 0 && noFeasible.selected === null
    && (noFeasible.termination as { reason?: unknown } | undefined)?.reason === "no_feasible_plan"
    && runtimeFailure?.status === "not_reached"
    && (runtimeFailure.failure as { kind?: unknown } | undefined)?.kind === "runtime_failure"
    && runtimeFailure.termination === null;
}

function changes(value: DiagnosticProbe): string {
  return Object.entries(value.changed).filter(([, changed]) => changed).map(([key]) => key).join(", ") || "none";
}

function runSummary(value: DiagnosticProbe): string[] {
  return value.runs.map(run => `${run.label}: status=${run.runtimeStatus ?? "unknown"}; runtimeSuccess=${run.runtimeCompleted}; constraints=${JSON.stringify({
    destination: run.constraints?.destination,
    role: run.constraints?.group.leadRole,
    budget: run.constraints?.group.preferences.budget,
    cuisine: run.constraints?.group.preferences.preferredCuisine,
    dietary: run.constraints?.group.preferences.dietaryRestrictions,
    hardMaxKm: run.constraints?.distance.hardMaxKm,
    preferredMaxKm: run.constraints?.distance.preferredMaxKm,
    durationHours: run.constraints?.timeWindow.durationHours,
    extraHints: run.constraints?.extraHints,
  })}; searchPool=${JSON.stringify([...new Set(run.searches.flatMap(search => search.returnedIds))].sort())}; selected=${JSON.stringify(run.selectedPlan?.activities.map(activity => activity.id) ?? [])}; pareto=${JSON.stringify(run.pareto)}; errors=${JSON.stringify(run.runtimeErrors)}`);
}

function defects(probes: DiagnosticProbe[], audits: Record<string, unknown>): DecisionQualityAudit["defects"] {
  const distance = probe(probes, "preferred-distance");
  const cuisine = probe(probes, "cuisine-preference");
  const dietary = probe(probes, "dietary-restriction");
  const pace = probe(probes, "pace-extra-hint");
  const local = probe(probes, "local-feature-hint");
  const group = probe(probes, "group-suitability");
  const hard = probe(probes, "hard-distance");
  const order = probe([audits.tieBreak as DiagnosticProbe], "tie-break-order");
  const noFeasible = audits.noFeasible as Record<string, unknown>;
  const schema = audits.planSchema as Record<string, unknown>;
  const hardGate = audits.hardGate as Record<string, unknown>;
  const correction = probe(probes, "preference-correction");
  const recommendationPreference = audits.recommendationPreference as Record<string, unknown>;
  const dq01Closed = isDq01Closed(audits.distancePreference as Record<string, unknown>);
  const result: DecisionQualityAudit["defects"] = [];
  const dq05Closed = isDq05Closed(hardGate);
  const dq08Closed = isDq08Closed(schema);
  const dq02Closed = isDq02Closed(audits.dietaryCompatibility as Record<string, unknown>);
  const dq06Closed = isDq06Closed(order);
  const dq11Closed = isDq11Closed(recommendationPreference);
  const dq04Closed = isDq04Closed(audits.groupSuitability as Record<string, unknown>);
  const dq09Closed = isDq09Closed(audits.explanationFidelity as Record<string, unknown>);

  if (!dq01Closed) result.push({
    id: "DQ-01",
    classification: "DECISION_EFFECTIVENESS",
    claim: "preferredMaxKm 尚未在相同 hard-feasible candidate set 上改变软偏好评分和方案选择。",
    codeEvidence: ["src/planner/search-policy.ts:createInitialSearchPolicy 将 preferredMaxKm 用作初始搜索半径。", "src/decision/score.ts 的 preference dimension 应消费连续距离偏好；hard feasibility 仍只依据 hardMaxKm。"],
    runtimeEvidence: [JSON.stringify(audits.distancePreference), ...runSummary(distance)],
  });
  if (!dq02Closed) result.push({
    id: "DQ-02",
    classification: "CORRECTNESS",
    claim: "具体忌口仍未被可靠保留并作为逐餐厅、逐要求的硬约束验证；通用 dietaryOptions 不足以证明兼容。",
    codeEvidence: ["检查规范化忌口是否贯通 parser/memory/search hint。", "检查 ConstraintEngine 是否要求每个餐厅对每项硬忌口有明确支持证据，且不把 generic dietaryOptions 当证据。"],
    runtimeEvidence: [...runSummary(dietary), JSON.stringify(audits.dietaryCompatibility)],
  });
  result.push({
    id: "DQ-03",
    classification: "DECISION_EFFECTIVENESS",
    claim: "pace/local-feature/餐饮或 attraction 自由文本提示解析进 extraHints 后没有形成可执行检索或决策偏好；当地特色评分按‘有任意 feature’泛化，未匹配用户想要的 feature。",
    codeEvidence: ["src/intent/parser.ts:extraHints 收集‘不要太赶’、‘展览’等；src/planner/stages.ts:stage3_generateCandidates 构造 PlaceSearchRequest 时未消费 constraints.extraHints。", "src/decision/score.ts:scorePreference 任意 localFeatures.length>0 都增加相同分，不和用户指定 feature 对齐。"],
    runtimeEvidence: [...runSummary(pace), ...runSummary(local)],
  });
  if (!dq04Closed) result.push({
    id: "DQ-04",
    classification: "DECISION_EFFECTIVENESS",
    claim: "group/companion 影响检索标签、break 检索及少量景点重排，但最终 crowd/experience ranking 没有计算‘候选与同行人群是否适配’；把人群适配作为维度名会掩盖它实际测的是拥挤度。",
    codeEvidence: ["src/planner/stages.ts:getCrowdTagsForScenario/rerankForScenario 只在搜索/景点启发式环节利用 group 信息。", "src/decision/score.ts:scoreCrowd 对 predictCrowd.level 惩罚求平均，不读取 crowdTags、leadRole 或 ageGroup。", "src/decision/context.ts:hasVulnerable 只调整 crowd/transit 权重，不计算候选适配度。"],
    runtimeEvidence: [...runSummary(group), JSON.stringify(audits.groupSuitability)],
  });
  if (!dq05Closed) {
    result.push({
      id: "DQ-05",
      classification: "CORRECTNESS",
      claim: "硬约束检查未在 Stage 4 形成完整候选过滤，存在违规方案进入后续评分与选择的风险。",
      codeEvidence: ["src/planner/stages.ts:stage4_feasibilityCheck 应使用统一 hard-feasibility helper 分区候选。", "src/runtime/evaluator.ts:acceptSelectedPlan 应复用同一 hard-feasibility 定义。"],
      runtimeEvidence: [...runSummary(hard), `candidate hard-filter probe: ${JSON.stringify(hardGate)}`, `hard_distance_limit fixture audit: ${JSON.stringify(noFeasible)}`],
    });
  }
  if (!dq06Closed) result.push({
    id: "DQ-06",
    classification: "STABILITY",
    claim: "同分 representative selection 仍受候选输入顺序影响。",
    codeEvidence: ["src/decision/pareto.ts:compareScoredPlans 在业务分数相同时按 canonical plan identity 稳定排序。", "src/decision/plan-identity.ts 使用固定角色顺序和稳定 Place IDs 构造非业务身份键。"],
    runtimeEvidence: runSummary(order),
  });
  result.push({
    id: "DQ-07",
    classification: "ARCHITECTURE",
    claim: "DQ-07 Phase A/B 已完成；Phase C 建立 typed PlanSpecification，并让单活动、meal required/none 驱动模板与 Runtime。但多活动仍缺少语义路线顺序，meal optional 的偏好维度也不能显式表达 per-plan not-applicable，因此 DQ-07 保持 OPEN。",
    codeEvidence: ["src/intent/parser.ts 与 src/llm/intent.ts 仅输出明确表达的 PlanSpecification。", "src/planner/plan-composition.ts:buildActivityPlanTemplate 将 resolved specification 映射到唯一领域 template。", "src/constraints/plan-completeness.ts 将用户 exact count/meal none 作为 min/max user requirement；默认 template max 仍非验收规则。", "src/planner/stages.ts 在没有路线排序逻辑时以 MULTI_ACTIVITY_SEQUENCE_GAP 阻止 count>1 被降级或伪装成功。", "src/decision/score.ts 暂无 meal-preference applicability 状态，optional meal + cuisine 仍是 MEAL_PREFERENCE_APPLICABILITY_GAP。", "src/runtime/replanner.ts 保留解析后的结构与相同验收 requirements。"],
    runtimeEvidence: [`slot composition probe: ${JSON.stringify(audits.planComposition)}`, `template-derived completeness probe: ${JSON.stringify(audits.planCompleteness)}`, "typed activity-only production Runtime probe: test/plan-specification.test.ts", "explicit multi-activity request remains gated by MULTI_ACTIVITY_SEQUENCE_GAP", "meal optional cuisine applicability remains gated by MEAL_PREFERENCE_APPLICABILITY_GAP", `plan schema probe: ${JSON.stringify(schema)}`],
  });
  if (!dq08Closed) result.push({
    id: "DQ-08",
    classification: "CORRECTNESS",
    claim: "明确的用户总时长上限尚未作为完整排程的硬验收约束。",
    codeEvidence: ["ConstraintEngine 应仅依据显式 hardMaxDurationMinutes 测量完整 scheduled plan；runtime 默认 timeWindow 不构成硬约束。"],
    runtimeEvidence: [`plan schema/time-window probe: ${JSON.stringify(schema)}`],
  });
  if (!dq09Closed) result.push({
    id: "DQ-09",
    classification: "EXPLANATION",
    claim: "偏好 explanation 与用户意图的对应关系不可靠：解释只复述维度得分原因；对任意 localFeature 都可说‘含当地特色’，但系统没有确认它是否是用户想要的特色。",
    codeEvidence: ["src/decision/score.ts:scorePreference 为任意 localFeatures 添加 PREF_LOCAL_FEATURE_BONUS 并生成‘含当地特色’。", "src/decision/explain.ts:explainPlan 仅按维度阈值拼接维度 reason，不核对用户需求—候选 feature 对应关系。"],
    runtimeEvidence: [JSON.stringify(audits.explanationFidelity), ...runSummary(local), ...runSummary(cuisine)],
  });
  const dq10 = audits.decisionTrace as Record<string, unknown>;
  if (!isDq10Closed(dq10)) result.push({
    id: "DQ-10",
    classification: "OBSERVABILITY",
    claim: "Runtime/Eval 快照没有完整保留 Stage 3 全部组合候选、逐候选 constraint evaluation 与各候选 score breakdown；只有 provider search evidence 和最终 Pareto/selected evidence，事后难以复原为何某候选被淘汰或胜出。",
    codeEvidence: ["src/planner/activity-planner.ts:stepData 对 candidate_generation/feasibility_check 只发 candidates/feasible 数量。", "eval/decision/evaluators/conversation.ts:DecisionScenarioTurnSnapshot 保留 candidateIds、最终 selectedPlan/finalDecision，不保留完整 Stage 3 候选评分轨迹。"],
    runtimeEvidence: [JSON.stringify(dq10), ...runSummary(distance), ...runSummary(hard)],
  });
  if (!dq11Closed) result.push({
    id: "DQ-11",
    classification: "DECISION_EFFECTIVENESS",
    claim: "Preference evaluator 尚未证明其主覆盖率只反映最终 selectedPlan，而非 Pareto 中的其它备选。",
    codeEvidence: ["eval/decision/evaluators/conversation.ts:evaluateRecommendedPlanPreferences 应以执行结果中的 selectedPlan 作为唯一推荐来源。", "CLI、LangSmith 和 Artifact 应统一使用 recommendation-scoped preference coverage。"],
    runtimeEvidence: [JSON.stringify(recommendationPreference), ...runSummary(correction)],
  });
  return result;
}

export function buildDecisionQualityAudit(input: {
  probes: DiagnosticProbe[];
  tieBreak: DiagnosticProbe;
  audits: Record<string, unknown>;
}): DecisionQualityAudit {
  const dq01Closed = isDq01Closed(input.audits.distancePreference as Record<string, unknown>);
  const dq05Closed = isDq05Closed(input.audits.hardGate as Record<string, unknown>);
  const dq08Closed = isDq08Closed(input.audits.planSchema as Record<string, unknown>);
  const dq02Closed = isDq02Closed(input.audits.dietaryCompatibility as Record<string, unknown>);
  const dq11Closed = isDq11Closed(input.audits.recommendationPreference as Record<string, unknown>);
  const dq04Closed = isDq04Closed(input.audits.groupSuitability as Record<string, unknown>);
  const dq09Closed = isDq09Closed(input.audits.explanationFidelity as Record<string, unknown>);
  const dq10Closed = isDq10Closed(input.audits.decisionTrace as Record<string, unknown>);
  return {
    schemaVersion: "decision-quality-audit-v1.0",
    benchmarkVersion: DECISION_BENCHMARK_VERSION,
    generatedAt: new Date().toISOString(),
    diagnosticOnly: true,
    productionLogicModified: false,
    pipeline: PIPELINE,
    influenceMatrix: INFLUENCE_MATRIX,
    scoreFeatures: SCORE_FEATURES,
    tieBreak: {
      policy: isDq06Closed(input.tieBreak)
        ? "分数不同由业务分数决定；完全相等时统一按 canonical plan identity 字典序作非业务 fallback。Provider order reversal probe 中 selected plan 和 objective representatives 保持不变。"
        : "DQ-06 仍开放：Provider order reversal probe 未证明同分 winner 和 objective representatives 与输入顺序无关。",
      probe: input.tieBreak,
    },
    probes: input.probes,
    audits: input.audits,
    defects: defects(input.probes, { ...input.audits, tieBreak: input.tieBreak }),
    recommendation: dq01Closed && dq05Closed && dq08Closed && dq02Closed && dq11Closed && dq04Closed && dq09Closed && dq10Closed && isDq06Closed(input.tieBreak)
      ? {
          defectId: "none",
          target: "DQ-01、DQ-02、DQ-04、DQ-05、DQ-06、DQ-08、DQ-09、DQ-10 与 DQ-11 已由对应证据探针确认关闭；DQ-03 与 DQ-07 仍开放。",
          rationale: "本次诊断只验证当前状态，不提出或实施范围外修改。",
        }
      : {
          defectId: !dq01Closed ? "DQ-01" : !dq05Closed ? "DQ-05" : !dq08Closed ? "DQ-08" : !dq02Closed ? "DQ-02" : !dq04Closed ? "DQ-04" : !dq09Closed ? "DQ-09" : !dq11Closed ? "DQ-11" : "DQ-06",
          target: !dq01Closed ? "让 preferredMaxKm 在同一 hard-feasible candidate set 上影响连续 preference score 和选择，但不进入 hard filter。" : !dq05Closed ? "将 ConstraintEngine 的硬约束接入候选过滤，并在选出 Plan 前执行最终 acceptance。" : !dq08Closed ? "将显式用户时长上限加入共享 hard-feasibility contract，并验证超时完整排程在评分前被拒绝。" : !dq02Closed ? "让规范化的具体忌口要求在 ConstraintEngine 中逐项硬校验，并拒绝 unknown/unsupported 证据。" : !dq04Closed ? "让结构化同行人群适配证据进入 preference 软排序，并用固定候选证明上下文因果影响。" : !dq09Closed ? "让 selected Plan 的解释只陈述可由最终约束和结构化属性证明的理由。" : !dq11Closed ? "让 Preference coverage 只评价最终 selectedPlan，并让 no-plan outcome 从该指标分母排除。" : "让同分 representative selection 与 Provider 输入顺序无关。",
          rationale: !dq01Closed ? "DQ-01 targeted probe 未同时证明相同候选集上的软评分与选择因果关系。" : !dq05Closed ? "DQ-05 probe 仍观察到硬违规候选进入后续方案选择。" : !dq08Closed ? "DQ-08 probe 尚未确认明确时长超限被 hard-reject。" : !dq02Closed ? "DQ-02 probe 尚未证明具体忌口正确性闭环。" : !dq04Closed ? "DQ-04 targeted same-candidate probe 未通过。" : !dq09Closed ? "DQ-09 explanation evidence probe 未通过。" : !dq11Closed ? "DQ-11 selected-plan probe 或跨 adapter 语义证据不完整。" : "DQ-06 reversal probe 未通过稳定性条件。",
        },
  };
}

export function renderDecisionQualityMarkdown(audit: DecisionQualityAudit): string {
  const lines = [
    "# Decision Quality Diagnostic Audit",
    "",
    `- Benchmark: ${audit.benchmarkVersion}`,
    `- Generated: ${audit.generatedAt}`,
    "- Scope: deterministic audit of the current working tree; audit execution itself does not modify production logic",
    "- Evaluation method: deterministic; no LLM Judge",
    "",
    "## 1. Decision selection pipeline",
    "",
    ...audit.pipeline.flatMap((step, index) => [`${index + 1}. **${step.stage}** — ${step.evidence}`]),
    "",
    "## 2. Constraint influence matrix",
    "",
    "| Field | Parsed | Remembered | Search | Hard filter | Ranking | Pareto | Explanation | Classification |",
    "|---|---|---|---|---|---|---|---|---|",
    ...audit.influenceMatrix.map(row => `| ${row.field} | ${row.parsed} | ${row.remembered} | ${row.search} | ${row.hardFilter} | ${row.ranking} | ${row.pareto} | ${row.explanation} | ${row.classification} |`),
    "",
    "## 3. Score and Pareto feature inventory",
    "",
    ...audit.scoreFeatures.map(feature => `### ${feature.feature}\n\n- Source: ${feature.source}\n- Normalization: ${feature.normalization}\n- Direction: ${feature.direction}\n- Missing values: ${feature.missingValues}\n- Used by: ${feature.usedBy}\n`),
    "Pareto selection is implemented as independent objective argmax selection and deduplication, not a nondominated-front calculation. Objective order is `balanced`, `experience`, `time_saver`, `budget_saver`; the first selected plan is the recommended plan.",
    "",
    "## 4. Diagnostic probes",
    "",
    ...audit.probes.map(item => `### ${item.id}: ${item.description}\n\n- Category: ${item.category}\n- Changed outputs: ${changes(item)}\n- Observation: ${item.observation}\n${runSummary(item).map(line => `- Run: ${line}`).join("\n")}\n`),
    "## 5. Tie-break behavior",
    "",
    audit.tieBreak.policy,
    "",
    `- Probe: ${audit.tieBreak.probe.observation}`,
    ...runSummary(audit.tieBreak.probe).map(line => `- Run: ${line}`),
    "",
    "## 6. Replan, no-feasible, and plan-schema audits",
    "",
    `- Replan: ${JSON.stringify(audit.audits.replan, null, 2)}`,
    `- No-feasible: ${JSON.stringify(audit.audits.noFeasible, null, 2)}`,
    `- Hard constraint gate: ${JSON.stringify(audit.audits.hardGate, null, 2)}`,
    `- Specific dietary compatibility: ${JSON.stringify(audit.audits.dietaryCompatibility, null, 2)}`,
    `- Plan schema/time window: ${JSON.stringify(audit.audits.planSchema, null, 2)}`,
    "",
    "## 7. Defects and evidence",
    "",
    ...audit.defects.map(defect => `### ${defect.id} — ${defect.classification}\n\n${defect.claim}\n\nCode evidence:\n${defect.codeEvidence.map(item => `- ${item}`).join("\n")}\n\nRuntime/probe evidence:\n${defect.runtimeEvidence.map(item => `- ${item}`).join("\n")}\n`),
    "## 8. Recommendation / scope status",
    "",
    `- Target: ${audit.recommendation.target}`,
    `- Rationale: ${audit.recommendation.rationale}`,
    "",
    "## 9. Scope and caveats",
    "",
    "The audit runner does not mutate production behavior. Its findings describe the current working tree, including whether DQ-05 is closed. Diagnostic scenarios are Eval-only and do not enter the canonical Decision Benchmark. Fixture-level infeasibility is not a statement about the real-world POI catalog.",
    "",
  ];
  return lines.join("\n");
}
