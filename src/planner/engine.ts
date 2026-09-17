// ============================================================
// src/planner/engine.ts — ActivityPlanner compatibility adapters
// ============================================================

import {
  createAgentState,
  type AgentState,
  type RunId,
  type SessionId,
  type TraceId,
} from "../../spec/agent.js";
import type {
  PlanningState,
  StructuredConstraints,
} from "../../spec/types.js";
import { defaultRuntimeEventBus } from "../runtime/event-bus.js";
import { defaultActivityPlanner } from "./activity-planner.js";

export interface PlanResult {
  success: boolean;
  /** 兼容旧调用方的业务状态快照 */
  state: PlanningState;
  message: string;
  /** Runtime 运行快照 */
  agentState: AgentState;
}
export interface PipelineOptions {
  parseFn?: (text: string) => StructuredConstraints;
  runId?: RunId;
  sessionId?: SessionId;
  traceId?: TraceId;
  profile?: import("../../spec/profile.js").UserProfile;
  autoSegment?: boolean;
  weather?: import("../../spec/decision.js").WeatherCondition;
  date?: Date;
  signal?: AbortSignal;
}

export type PlanningStageName = import("../../spec/types.js").PlanningStage;

export interface StageEvent {
  stage: PlanningStageName;
  index: number;
  total: number;
  message: string;
  data?: Record<string, unknown>;
}

const STAGE_TITLES: Record<PlanningStageName, string> = {
  intent_parsing: "意图解析",
  follow_up_questions: "追问确认",
  candidate_generation: "候选生成",
  feasibility_check: "可行性校验",
  fine_scheduling: "多维决策",
};

export {
  stage1_parseIntent,
  stage2_followUp,
  stage3_generateCandidates,
  stage4_feasibilityCheck,
  stage5_selectBest,
} from "./stages.js";

/** @deprecated Runtime 入口请使用 ActivityPlanner.run()。 */
export async function runFullPipeline(
  rawText: string,
  parseFn?: (text: string) => StructuredConstraints,
  opts: PipelineOptions = {},
): Promise<PlanResult> {
  const agentState = createAgentState(
    { rawText, config: { ...opts } },
    { runId: opts.runId, sessionId: opts.sessionId, traceId: opts.traceId },
  );
  return defaultActivityPlanner.run(agentState, { ...opts, parseFn });
}

/** @deprecated Runtime 入口请使用 ActivityPlanner.run()；SSE 请消费 Runtime EventBus。 */
export async function runFullPipelineStreaming(
  rawText: string,
  parseFn: ((text: string) => StructuredConstraints) | undefined,
  opts: PipelineOptions = {},
  onStage?: (event: StageEvent) => void | Promise<void>,
): Promise<PlanResult> {
  const agentState = createAgentState(
    { rawText, config: { ...opts } },
    { runId: opts.runId, sessionId: opts.sessionId, traceId: opts.traceId },
  );
  const subscription = defaultRuntimeEventBus.subscribe(agentState.traceId);
  const runPromise = defaultActivityPlanner.run(agentState, { ...opts, parseFn });

  try {
    for await (const event of subscription) {
      if (event.type === "stage_update") {
        const stage = event.metadata?.stage as PlanningStageName;
        if (onStage && stage) {
          await onStage({
            stage,
            index: Number(event.metadata?.index ?? 0),
            total: Number(event.metadata?.total ?? 0),
            message: STAGE_TITLES[stage],
            data: event.metadata?.data as Record<string, unknown> | undefined,
          });
        }
      }
      if (event.type === "final") break;
    }
    return await runPromise;
  } finally {
    subscription.close();
  }
}
