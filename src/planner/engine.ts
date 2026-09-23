// ============================================================
// src/planner/engine.ts — ActivityPlanner compatibility adapters
// ============================================================

import {
  type AgentState,
  type RunId,
  type SessionId,
  type TraceId,
} from "../../spec/agent.js";
import type {
  PlanningState,
  StructuredConstraints,
} from "../../spec/types.js";
import type { AgentEvent } from "../../spec/agent-event.js";
import {
  defaultAgentEventBus,
  type AgentEventSubscriber,
} from "../runtime/event-bus.js";
import { defaultActivityPlanner } from "./activity-planner.js";
import { AgentRun } from "../runtime/agent-run.js";
import type { ToolRegistryLike } from "../runtime/tool-executor.js";

export interface PlanResult {
  success: boolean;
  /** 兼容旧调用方的业务状态快照 */
  state: PlanningState;
  message: string;
  /** Runtime 运行快照 */
  agentState: AgentState;
}
export interface PipelineOptions {
  requestFollowUp?: (questions: import("../../spec/types.js").FollowUpQuestion[]) => Promise<import("../../spec/follow-up.js").FollowUpSelection[]>;
  baseConstraints?: StructuredConstraints;
  parseFn?: (text: string) => StructuredConstraints;
  runId?: RunId;
  sessionId?: SessionId;
  traceId?: TraceId;
  profile?: import("../../spec/profile.js").UserProfile;
  autoSegment?: boolean;
  weather?: import("../../spec/decision.js").WeatherCondition;
  date?: Date;
  signal?: AbortSignal;
  /** Optional per-runtime Tool registry, including injected LocationResolver. */
  toolRegistry?: ToolRegistryLike;
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

let nextStageSubscriberId = 0;

/** 旧回调接口的兼容 Subscriber；串行交付由 EventBus 负责。 */
class StageUpdateSubscriber implements AgentEventSubscriber {
  readonly id: string;

  constructor(
    private readonly traceId: string,
    private readonly onStage?: (event: StageEvent) => void | Promise<void>,
  ) {
    nextStageSubscriberId += 1;
    this.id = `stage-callback:${traceId}:${nextStageSubscriberId}`;
  }

  matches(event: AgentEvent): boolean {
    return event.scope.traceId === this.traceId && event.type === "stage_update";
  }

  handle(event: AgentEvent): void | Promise<void> {
    if (event.type !== "stage_update") return;
    const stage = event.payload.stage as PlanningStageName;
    if (!this.onStage || !stage || !(stage in STAGE_TITLES)) return;
    const stageEvent: StageEvent = {
      stage,
      index: event.payload.index,
      total: event.payload.total,
      message: STAGE_TITLES[stage],
      data: event.payload.data,
    };
    return this.onStage(stageEvent);
  }
}

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
  const run = AgentRun.create(
    { rawText, config: { ...opts } },
    {
      runId: opts.runId,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      eventBus: defaultAgentEventBus,
    },
  );
  return defaultActivityPlanner.run(run, { ...opts, parseFn });
}

/** @deprecated Runtime 入口请使用 ActivityPlanner.run()；流式协议请注册 AgentEvent Subscriber。 */
export async function runFullPipelineStreaming(
  rawText: string,
  parseFn: ((text: string) => StructuredConstraints) | undefined,
  opts: PipelineOptions = {},
  onStage?: (event: StageEvent) => void | Promise<void>,
): Promise<PlanResult> {
  const run = AgentRun.create(
    { rawText, config: { ...opts } },
    {
      runId: opts.runId,
      sessionId: opts.sessionId,
      traceId: opts.traceId,
      eventBus: defaultAgentEventBus,
    },
  );
  const subscriber = new StageUpdateSubscriber(run.state.traceId, onStage);
  const subscription = defaultAgentEventBus.subscribe(subscriber);

  try {
    const result = await defaultActivityPlanner.run(run, { ...opts, parseFn });
    subscription.close();
    const delivery = await subscription.drain();
    if (delivery.failed || delivery.rejected) throw delivery.lastError;
    return result;
  } finally {
    subscription.close();
  }
}
