import type { DecisionResult } from "./decision.js";
import type { Plan, StructuredConstraints } from "./types.js";

export type ConversationTurnRole = "user" | "assistant" | "system";
export type ConversationTurnKind = "text" | "choice" | "plan";

export interface ConversationTurn {
  id: string;
  role: ConversationTurnRole;
  kind: ConversationTurnKind;
  content: string;
  createdAt: number;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationPlanVersion {
  version: number;
  runId: string;
  decision: DecisionResult;
  selectedPlan: Plan;
  constraints: StructuredConstraints;
  createdAt: number;
  acceptedAt?: number;
}

/** 仅在当前 Conversation 内生效的短期记忆。 */
export interface ConversationMemory {
  revision: number;
  constraints?: StructuredConstraints;
  currentPlanVersion?: number;
  acceptedPlanVersion?: number;
  pendingQuestionRequestId?: string;
}

export interface PlanningConversation {
  id: string;
  title: string;
  turns: ConversationTurn[];
  memory: ConversationMemory;
  plans: ConversationPlanVersion[];
  createdAt: number;
  updatedAt: number;
}
