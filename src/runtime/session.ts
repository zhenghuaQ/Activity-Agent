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

export interface SessionStoreOptions {
  maxSessions?: number;
  idleTtlMs?: number;
  maxMessagesPerSession?: number;
}

const DEFAULT_MAX_SESSIONS = 500;
const DEFAULT_IDLE_TTL_MS = 30 * 60_000;
const DEFAULT_MAX_MESSAGES = 200;

export class InMemorySessionStore {
  private readonly sessions = new Map<SessionId, AgentSession>();
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly maxMessagesPerSession: number;

  constructor(options: SessionStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxMessagesPerSession = options.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES;
  }

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
    const appended = appendSessionMessage(session, message);
    const updated = {
      ...appended,
      messages: appended.messages.slice(-this.maxMessagesPerSession),
    };
    this.sessions.set(sessionId, updated);
    return updated;
  }

  replace(session: AgentSession): AgentSession {
    const bounded = {
      ...session,
      messages: session.messages.slice(-this.maxMessagesPerSession),
    };
    this.sessions.set(session.id, bounded);
    return bounded;
  }

  remove(sessionId: SessionId): boolean {
    return this.sessions.delete(sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  cleanup(
    protectedSessionIds: ReadonlySet<SessionId> = new Set(),
    now = Date.now(),
  ): void {
    for (const [sessionId, session] of this.sessions) {
      if (
        !protectedSessionIds.has(sessionId)
        && now - session.updatedAt > this.idleTtlMs
      ) {
        this.sessions.delete(sessionId);
      }
    }

    if (this.sessions.size <= this.maxSessions) return;
    const evictable = [...this.sessions.values()]
      .filter((session) => !protectedSessionIds.has(session.id))
      .sort((left, right) => left.updatedAt - right.updatedAt);

    for (const session of evictable) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(session.id);
    }
  }

  clear(): void {
    this.sessions.clear();
  }
}

export const defaultSessionStore = new InMemorySessionStore();
