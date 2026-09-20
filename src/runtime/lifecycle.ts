// Compatibility helpers. New Runtime code should operate on AgentRun directly.

import type { AgentRunStatus, AgentState } from "../../spec/agent.js";
import { AgentRun, type AgentRunTransitionContext } from "./agent-run.js";

export type RunTransitionContext = AgentRunTransitionContext;

export function ensureAgentRunCreated(state: AgentState): void {
  AgentRun.fromState(state).ensureCreated();
}

export function transitionAgentRunStatus(
  state: AgentState,
  nextStatus: AgentRunStatus,
  context: RunTransitionContext = {},
): void {
  AgentRun.fromState(state).transition(nextStatus, context);
}

export function requestAgentRunCancellation(
  state: AgentState,
  reason: string,
  source: "control" | "transport" = "control",
): void {
  AgentRun.fromState(state).requestCancellation(reason, source);
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
