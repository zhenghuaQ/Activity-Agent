// ============================================================
// eval/types.ts — Eval Harness V2 统一结果模型
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
