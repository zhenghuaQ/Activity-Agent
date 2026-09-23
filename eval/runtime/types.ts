// ============================================================
// eval/runtime/types.ts — Runtime Regression 结果模型
// ============================================================

export type EvalRunnerKind = "baseline" | "runtime";

export interface EvalCaseResult {
  caseName: string;
  runner: EvalRunnerKind;
  passed: boolean;
  taskSuccess: boolean;
  constraintPassRate: number;
  durationMs: number;
  replanCount: number;
  toolCalls: number;
  traceEvents: number;
  errors: string[];
  planId?: string;
  runtimeEntry?: "agent_runtime";
  terminalStatus?: "completed" | "failed" | "cancelled";
}

export interface EvalComparison {
  caseName: string;
  baseline: EvalCaseResult;
  runtime: EvalCaseResult;
  delta: {
    taskSuccess: number;
    constraintPassRate: number;
    durationMs: number;
    replanCount: number;
    toolCalls: number;
  };
}
