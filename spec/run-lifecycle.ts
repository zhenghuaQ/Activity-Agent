import type { AgentRunStatus } from "./agent.js";

export const RUN_TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  pending: ["running", "failed", "cancelled"],
  running: ["waiting_input", "completed", "failed", "cancelled"],
  waiting_input: ["running", "failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};

export function assertRunTransition(previous: AgentRunStatus, next: AgentRunStatus): void {
  if (!RUN_TRANSITIONS[previous].includes(next)) throw new Error(`invalid_agent_run_transition:${previous}->${next}`);
}
