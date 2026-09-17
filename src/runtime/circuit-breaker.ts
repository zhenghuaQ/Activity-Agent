// ============================================================
// src/runtime/circuit-breaker.ts — Tool 级熔断器
//
// 语义：3 次连续“逻辑调用”失败 -> OPEN；冷却后下一次调用进入
// HALF_OPEN 做单次探测；探测成功恢复 CLOSED，失败再次 OPEN。
// 熔断状态按 toolName 隔离，并通过懒惰检查完成 OPEN -> HALF_OPEN。
// ============================================================

export type CircuitState = "closed" | "open" | "half_open";
export type CircuitOutcome = "success" | "upstream_failure" | "neutral";

export interface CircuitStatus {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  halfOpenProbeInFlight: boolean;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

interface InternalStatus {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number;
  halfOpenProbeInFlight: boolean;
}

export class CircuitBreakerRegistry {
  private readonly circuits = new Map<string, InternalStatus>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3);
    this.cooldownMs = Math.max(0, options.cooldownMs ?? 30_000);
  }

  beforeCall(toolName: string, now = Date.now()): { allowed: boolean; state: CircuitState } {
    const status = this.getOrCreate(toolName);

    if (status.state === "open") {
      if ((status.openedAt ?? now) + this.cooldownMs > now) {
        return { allowed: false, state: "open" };
      }
      status.state = "half_open";
      status.halfOpenProbeInFlight = true;
      return { allowed: true, state: "half_open" };
    }

    if (status.state === "half_open") {
      if (status.halfOpenProbeInFlight) {
        return { allowed: false, state: "half_open" };
      }
      status.halfOpenProbeInFlight = true;
      return { allowed: true, state: "half_open" };
    }

    return { allowed: true, state: "closed" };
  }

  recordSuccess(toolName: string): void {
    const status = this.getOrCreate(toolName);
    status.state = "closed";
    status.consecutiveFailures = 0;
    status.openedAt = undefined;
    status.halfOpenProbeInFlight = false;
  }

  recordFailure(toolName: string, now = Date.now()): void {
    const status = this.getOrCreate(toolName);
    status.halfOpenProbeInFlight = false;

    if (status.state === "half_open") {
      this.open(status, now);
      return;
    }

    status.consecutiveFailures += 1;
    if (status.consecutiveFailures >= this.failureThreshold) {
      this.open(status, now);
    }
  }

  completeCall(
    toolName: string,
    outcome: CircuitOutcome,
    now = Date.now(),
  ): void {
    const status = this.getOrCreate(toolName);
    status.halfOpenProbeInFlight = false;

    if (outcome === "success") {
      this.recordSuccess(toolName);
    } else if (outcome === "upstream_failure") {
      this.recordFailure(toolName, now);
    }
  }

  getStatus(toolName: string): CircuitStatus {
    const status = this.getOrCreate(toolName);
    return { ...status };
  }

  reset(toolName?: string): void {
    if (toolName) {
      this.circuits.delete(toolName);
      return;
    }
    this.circuits.clear();
  }

  private getOrCreate(toolName: string): InternalStatus {
    let status = this.circuits.get(toolName);
    if (!status) {
      status = {
        state: "closed",
        consecutiveFailures: 0,
        halfOpenProbeInFlight: false,
      };
      this.circuits.set(toolName, status);
    }
    return status;
  }

  private open(status: InternalStatus, now: number): void {
    status.state = "open";
    status.openedAt = now;
    status.halfOpenProbeInFlight = false;
  }
}

/** 进程级默认注册表：不同 Run 共用同一个 Tool 健康状态。 */
export const defaultCircuitBreakerRegistry = new CircuitBreakerRegistry();
