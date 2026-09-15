// ============================================================
// src/runtime/session.ts — 轻量 Session Store
// ============================================================

import {
  appendSessionMessage,
  createAgentSession,
  type AgentMessage,
  type AgentSession,
  type SessionId,
  type UserId,
} from "../../spec/agent.js";

export class InMemorySessionStore {
  private readonly sessions = new Map<SessionId, AgentSession>();

  get(sessionId: SessionId): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getOrCreate(
    sessionId: SessionId,
    userId: UserId = "anonymous",
  ): AgentSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const created = createAgentSession(userId, { id: sessionId });
    this.sessions.set(sessionId, created);
    return created;
  }

  create(userId = "anonymous", sessionId?: SessionId): AgentSession {
    const session = createAgentSession(userId, { id: sessionId });
    this.sessions.set(session.id, session);
    return session;
  }

  appendMessage(sessionId: SessionId, message: AgentMessage): AgentSession {
    const session = this.getOrCreate(sessionId);
    const updated = appendSessionMessage(session, message);
    this.sessions.set(sessionId, updated);
    return updated;
  }

  replace(session: AgentSession): AgentSession {
    this.sessions.set(session.id, session);
    return session;
  }

  clear(): void {
    this.sessions.clear();
  }
}

export const defaultSessionStore = new InMemorySessionStore();
