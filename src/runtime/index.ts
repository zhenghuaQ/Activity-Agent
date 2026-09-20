export { ActivityPlanner, defaultActivityPlanner } from "../planner/activity-planner.js";

export {
  canRunConcurrently,
  createActivityRuntimePlan,
  getReadySteps,
  validateRuntimePlan,
  assertValidRuntimePlan,
} from "./plan.js";

export type {
  RuntimePlan,
  RuntimePlanStep,
  RuntimeStepType,
  ValidateRuntimePlanResult,
} from "./plan.js";

export {
  executePlan,
} from "./executor.js";

export type {
  ExecutePlanOptions,
  RuntimeStepHandler,
} from "./executor.js";

export { evaluateAgentState } from "./evaluator.js";
export type { AgentEvaluation } from "./evaluator.js";

export { decideReplan, applyReplanPatch } from "./replanner.js";
export type { ReplanDecision } from "./replanner.js";

export { ToolExecutor } from "./tool-executor.js";
export { classifyFailure } from "./tool-executor.js";
export type {
  ToolExecutorOptions,
  ToolFailure,
  ToolFailureKind,
  ToolFallback,
  ToolFallbackContext,
  ToolLike,
  ToolRegistryLike,
} from "./tool-executor.js";

export {
  InMemoryAgentEventCollector,
  appendAgentEvent,
  createAgentEvent,
} from "./trace.js";
export type { AgentEventCollector } from "./trace.js";
export { getAgentRunProjection } from "./trace.js";
export { createAgentRunProjection, reduceAgentEvent, replayAgentEvents } from "./event-reducer.js";
export type { AgentRunProjection } from "./event-reducer.js";

export { InMemoryAgentEventBus, defaultAgentEventBus } from "./event-bus.js";
export type {
  AgentEventBus,
  AgentEventSubscriber,
  AgentEventSubscription,
  DeliveryReport,
} from "./event-bus.js";
export type {
  AgentEvent,
  AgentEventCategory,
  AgentEventInput,
  AgentEventScope,
  AgentEventType,
} from "../../spec/agent-event.js";

export { CircuitBreakerRegistry, defaultCircuitBreakerRegistry } from "./circuit-breaker.js";
export type {
  CircuitBreakerOptions,
  CircuitOutcome,
  CircuitState,
  CircuitStatus,
} from "./circuit-breaker.js";

export {
  AgentRuntime,
  SubmissionRouter,
  defaultAgentRuntime,
} from "./router.js";
export type { AgentRuntimeOptions } from "./router.js";

export {
  createAgentInput,
  createSubmission,
} from "./submission.js";
export type {
  AgentInput,
  Submission,
  SubmissionId,
  InputId,
  SubmissionOp,
  SubmissionResult,
  SubmissionStatus,
  SessionRetention,
} from "./submission.js";

export { InMemorySessionStore, defaultSessionStore } from "./session.js";
export type { SessionStoreOptions } from "./session.js";
export { SessionScheduler, defaultSessionScheduler } from "./scheduler.js";
export type { SessionConcurrencyPolicy } from "./scheduler.js";

export { SessionSubmissionLoop, createSessionSubmissionLoop } from "./submission-loop.js";
export type { SubmissionLoopHandlers } from "./submission-loop.js";

export { linkAbortSignal, throwIfAborted } from "./abort.js";

export {
  ensureAgentRunCreated,
  isTerminalAgentRunStatus,
  requestAgentRunCancellation,
  transitionAgentRunStatus,
} from "./lifecycle.js";
export type { RunTransitionContext } from "./lifecycle.js";

export { AgentRun } from "./agent-run.js";
export type {
  AgentRunTransitionContext,
  CreateAgentRunOptions,
} from "./agent-run.js";
