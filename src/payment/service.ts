import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { PaymentConfirmation, PaymentIntent, PaymentStatus } from "../../spec/payment.js";
import { MockMerchant } from "./mock-merchant.js";

export class PaymentError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}

const NEXT: Record<PaymentStatus, PaymentStatus[]> = {
  risk_check: ["blocked", "awaiting_confirmation"],
  awaiting_confirmation: ["expired", "cancelled", "reserving"],
  reserving: ["paying", "compensating"], paying: ["fulfilling", "compensating"],
  fulfilling: ["succeeded", "compensating"], compensating: ["rolled_back", "manual_review"],
  blocked: [], expired: [], cancelled: [], succeeded: [], rolled_back: [], manual_review: [],
};

/** Payment workflow adjacent to Runtime; session/plan IDs correlate, never authorize payment.
 * Per-instance, in-memory demo only. No live adapter or live credentials are accepted.
 */
export class PaymentService {
  private intents = new Map<string, { value: PaymentIntent; accessToken: string }>();
  private inFlight = new Map<string, Promise<PaymentIntent>>();
  private readonly now: () => number;
  private readonly maxAmountMinor: number;
  private readonly confirmationTtlMs: number;

  constructor(readonly merchant = new MockMerchant(), options: {
    now?: () => number; maxAmountMinor?: number; confirmationTtlMs?: number;
  } = {}) {
    this.now = options.now ?? Date.now;
    // Explicit demonstration policy, not a financial risk model.
    this.maxAmountMinor = options.maxAmountMinor ?? 100_000;
    this.confirmationTtlMs = options.confirmationTtlMs ?? 300_000;
    if (merchant.mode !== "mock") throw new Error("live_payments_disabled");
    if (!Number.isSafeInteger(this.maxAmountMinor) || this.maxAmountMinor <= 0
      || !Number.isSafeInteger(this.confirmationTtlMs) || this.confirmationTtlMs <= 0) throw new Error("invalid_payment_policy");
  }

  create(input: { sessionId: string; productId: string; request: string; planId?: string }): {
    intent: PaymentIntent; accessToken: string;
  } {
    const start = performance.now();
    for (const value of [input.sessionId, input.productId, input.request]) {
      if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new PaymentError("invalid_request", 400);
    }
    if (input.planId !== undefined && (typeof input.planId !== "string" || !input.planId.trim() || input.planId.length > 200)) throw new PaymentError("invalid_plan_id", 400);
    let quote;
    try { quote = this.merchant.quote(input.productId); }
    catch { throw new PaymentError("unknown_product", 400); }
    const at = this.now();
    const value: PaymentIntent = {
      id: randomUUID(), mode: "mock", sessionId: input.sessionId, planId: input.planId,
      request: input.request, quote, status: "risk_check", confirmationToken: randomUUID(),
      createdAt: at, expiresAt: at + this.confirmationTtlMs,
      events: [{ sequence: 1, at, status: "risk_check", reason: "server_catalog_quote" }],
      processingMs: 0, externalCostCny: 0,
    };
    const accessToken = randomUUID();
    this.intents.set(value.id, { value, accessToken });
    const allowed = Number.isSafeInteger(quote.amountMinor) && quote.amountMinor > 0
      && quote.amountMinor <= this.maxAmountMinor && quote.currency === "CNY";
    this.transition(value, allowed ? "awaiting_confirmation" : "blocked", allowed ? "confirmation_required" : "demo_amount_limit");
    value.processingMs += performance.now() - start;
    return { intent: structuredClone(value), accessToken };
  }

  get(id: string, accessToken: string): PaymentIntent {
    const value = this.authorized(id, accessToken);
    this.expire(value);
    return structuredClone(value);
  }

  cancel(id: string, accessToken: string): PaymentIntent {
    const value = this.authorized(id, accessToken);
    this.expire(value);
    if (value.status === "cancelled") return structuredClone(value);
    if (value.status !== "awaiting_confirmation") throw new PaymentError("not_cancellable");
    this.transition(value, "cancelled", "user_cancelled");
    return structuredClone(value);
  }

  async confirm(id: string, accessToken: string, confirmation: PaymentConfirmation): Promise<PaymentIntent> {
    const value = this.authorized(id, accessToken);
    if (!confirmation || confirmation.accepted !== true || confirmation.confirmationToken !== value.confirmationToken
      || confirmation.amountMinor !== value.quote.amountMinor || confirmation.currency !== value.quote.currency
      || confirmation.merchantId !== value.quote.merchantId || confirmation.quoteVersion !== value.quote.version) {
      throw new PaymentError("explicit_quote_confirmation_required", 400);
    }
    this.expire(value);
    const pending = this.inFlight.get(id);
    if (pending) return structuredClone(await pending);
    if (["succeeded", "rolled_back", "manual_review"].includes(value.status)) return structuredClone(value);
    if (value.status !== "awaiting_confirmation") throw new PaymentError(`confirmation_not_allowed:${value.status}`);
    value.confirmedAt = this.now();
    this.transition(value, "reserving", "explicit_user_confirmation");
    const work = this.execute(value);
    this.inFlight.set(id, work);
    try { return structuredClone(await work); }
    finally { this.inFlight.delete(id); }
  }

  private authorized(id: string, accessToken: string): PaymentIntent {
    const record = this.intents.get(id);
    if (!record || !accessToken || record.accessToken !== accessToken) throw new PaymentError("payment_not_found", 404);
    return record.value;
  }

  private expire(value: PaymentIntent): void {
    if (value.status === "awaiting_confirmation" && this.now() >= value.expiresAt) this.transition(value, "expired", "quote_expired");
  }

  private transition(value: PaymentIntent, status: PaymentStatus, reason: string): void {
    if (!NEXT[value.status].includes(status)) throw new Error(`invalid_payment_transition:${value.status}:${status}`);
    value.status = status;
    value.events.push({ sequence: value.events.length + 1, at: this.now(), status, reason });
    if (NEXT[status].length === 0) value.completedAt = this.now();
  }

  private async execute(value: PaymentIntent): Promise<PaymentIntent> {
    const start = performance.now();
    try {
      await this.merchant.reserve(value.id);
      this.transition(value, "paying", "reservation_created");
      const paymentId = await this.merchant.charge(value.id);
      this.transition(value, "fulfilling", "mock_payment_recorded");
      const orderId = await this.merchant.fulfill(value.id);
      value.receipt = { orderId, paymentId, amountMinor: value.quote.amountMinor, currency: value.quote.currency, mode: "mock" };
      this.transition(value, "succeeded", "order_and_receipt_created");
    } catch {
      this.transition(value, "compensating", "execution_failed_reconcile_before_rollback");
      try {
        const ledger = await this.merchant.lookup(value.id);
        if (ledger?.charged && !ledger.refunded) await this.merchant.refund(value.id);
        await this.merchant.cancel(value.id);
        const finalLedger = await this.merchant.lookup(value.id);
        if (finalLedger?.reserved || (finalLedger?.charged && !finalLedger.refunded)) throw new Error("rollback_unverified");
        this.transition(value, "rolled_back", "no_outstanding_charge_or_reservation");
      } catch {
        this.transition(value, "manual_review", "reconciliation_or_compensation_unresolved_do_not_retry_payment");
      }
    } finally { value.processingMs += performance.now() - start; }
    return value;
  }
}
