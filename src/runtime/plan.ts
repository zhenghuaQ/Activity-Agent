// ============================================================
// src/runtime/plan.ts — Runtime 执行计划契约
//
// Runtime Plan 描述“本次 Agent Run 要执行哪些步骤”，
// 与 Activity 领域里的 Plan（最终出行方案）刻意区分。
//
// 当前版本已经具备轻量 DAG 语义：
//   dependsOn → 拓扑依赖
//   reads     → 读取的逻辑资源
//   writes    → 写入的逻辑资源
//
// Executor 第一阶段仍然串行执行，但 Ready Set 已经按 DAG
// 计算，为下一阶段真正的受限并发执行做好基础。
// ============================================================

import type { PlanningStage } from "../../spec/types.js";

/** Runtime 编排专用步骤，不属于 Activity 领域 PlanningStage。 */
export type RuntimeSystemStep = "context_resolution";

export type RuntimeStepType = RuntimeSystemStep | PlanningStage;

export interface RuntimePlanStep {
  id: string;
  type: RuntimeStepType;
  /** 当前步骤必须等待哪些步骤完成。 */
  dependsOn?: string[];
  /** 当前步骤只读的逻辑状态/资源名。用于未来并发冲突分析。 */
  reads?: string[];
  /** 当前步骤会写入的逻辑状态/资源名。用于未来并发冲突分析。 */
  writes?: string[];
}

export interface RuntimePlan {
  id: string;
  steps: RuntimePlanStep[];
}

export interface ValidateRuntimePlanResult {
  valid: boolean;
  errors: string[];
}

/**
 * 校验 Runtime Plan 的结构完整性。
 *
 * 校验项：
 *   1. step id 唯一
 *   2. dependsOn 指向存在的 step
 *   3. 禁止自依赖
 *   4. 禁止循环依赖
 *
 * 资源读写冲突不在这里直接判 invalid，因为同一份 Plan
 * 可以合法存在“潜在冲突”，Executor 未来只需避免让冲突
 * 步骤进入同一个并发 Ready Set 即可。
 */
export function validateRuntimePlan(plan: RuntimePlan): ValidateRuntimePlanResult {
  const errors: string[] = [];
  const byId = new Map<string, RuntimePlanStep>();

  for (const step of plan.steps) {
    if (byId.has(step.id)) {
      errors.push(`重复的 Runtime Step ID: ${step.id}`);
      continue;
    }
    byId.set(step.id, step);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id) {
        errors.push(`Runtime Step 不能依赖自身: ${step.id}`);
      } else if (!byId.has(dependency)) {
        errors.push(`Runtime Step ${step.id} 依赖不存在的 Step: ${dependency}`);
      }
    }
  }

  // Kahn 拓扑排序：如果最终没有处理完全部节点，则存在环。
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const step of plan.steps) {
    indegree.set(step.id, 0);
    outgoing.set(step.id, []);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn ?? []) {
      if (!byId.has(dependency) || dependency === step.id) continue;
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      outgoing.get(dependency)?.push(step.id);
    }
  }

  const queue = plan.steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  let processed = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    processed += 1;

    for (const next of outgoing.get(current) ?? []) {
      const nextIndegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextIndegree);
      if (nextIndegree === 0) queue.push(next);
    }
  }

  if (processed !== plan.steps.length) {
    errors.push("Runtime Plan 存在循环依赖，无法形成有效 DAG");
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidRuntimePlan(plan: RuntimePlan): void {
  const result = validateRuntimePlan(plan);
  if (!result.valid) {
    throw new Error(`Invalid Runtime Plan:\n${result.errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

/**
 * 判断两个步骤能否在同一个并发批次中运行。
 *
 * 规则：
 *   - write/write 冲突 → 不能并行
 *   - A write 到 X、B read X → 不能并行
 *   - A read X、B write X → 不能并行
 *   - 只有纯读或互不相关写入 → 可以并行
 */
export function canRunConcurrently(left: RuntimePlanStep, right: RuntimePlanStep): boolean {
  const leftReads = new Set(left.reads ?? []);
  const leftWrites = new Set(left.writes ?? []);
  const rightReads = new Set(right.reads ?? []);
  const rightWrites = new Set(right.writes ?? []);

  for (const resource of leftWrites) {
    if (rightWrites.has(resource) || rightReads.has(resource)) return false;
  }

  for (const resource of rightWrites) {
    if (leftReads.has(resource)) return false;
  }

  return true;
}

/**
 * 从当前完成/执行中的节点中计算 Ready Set。
 *
 * 这里只判断拓扑依赖，不修改 state，也不启动 handler。
 * runningStepIds 用于避免同一个 step 被重复调度。
 */
export function getReadySteps(
  plan: RuntimePlan,
  completedStepIds: ReadonlySet<string>,
  runningStepIds: ReadonlySet<string> = new Set()
): RuntimePlanStep[] {
  assertValidRuntimePlan(plan);

  return plan.steps.filter((step) => {
    if (completedStepIds.has(step.id) || runningStepIds.has(step.id)) return false;
    return (step.dependsOn ?? []).every((dependency) => completedStepIds.has(dependency));
  });
}

/**
 * 当前默认 Activity workflow。依赖关系仍然是串行的，
 * 等 Executor DAG 能力稳定后，再将候选搜索等独立步骤拆成并行节点。
 */
export function createActivityRuntimePlan(): RuntimePlan {
  return {
    id: "activity-default-v1",
    steps: [
      {
        id: "context_resolution",
        type: "context_resolution",
        dependsOn: [],
        writes: ["environment.location"],
      },
      {
        id: "intent_parsing",
        type: "intent_parsing",
        dependsOn: [],
        writes: ["planning.intent"],
      },
      {
        id: "follow_up_questions",
        type: "follow_up_questions",
        dependsOn: ["intent_parsing"],
        reads: ["planning.intent"],
        writes: ["planning.follow_up"],
      },
      {
        id: "candidate_generation",
        type: "candidate_generation",
        dependsOn: ["context_resolution", "follow_up_questions"],
        reads: ["planning.intent", "planning.follow_up", "environment.location"],
        writes: ["planning.candidates"],
      },
      {
        id: "feasibility_check",
        type: "feasibility_check",
        dependsOn: ["candidate_generation"],
        reads: ["planning.candidates"],
        writes: ["planning.evaluations"],
      },
      {
        id: "fine_scheduling",
        type: "fine_scheduling",
        dependsOn: ["feasibility_check"],
        reads: ["planning.candidates", "planning.evaluations"],
        writes: ["planning.decision"],
      },
    ],
  };
}
