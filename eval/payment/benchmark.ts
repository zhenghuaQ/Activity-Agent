import { performance } from "node:perf_hooks";
import type { PaymentConfirmation, PaymentIntent, PaymentStatus } from "../../spec/payment.js";
import { MockMerchant, type MockFault } from "../../src/payment/mock-merchant.js";
import { PaymentService } from "../../src/payment/service.js";

export interface PaymentCaseResult {
  id: string;
  status: PaymentStatus;
  taskSuccess: boolean;
  humanTakeover: boolean;
  expectedBehaviorPass: boolean;
  externalCostCny: number;
  processingMs: number;
  endToEndMs: number;
}

const CASES: { id: string; productId?: string; fault?: MockFault; action?: "cancel" | "expire" | "none" | "tamper"; limit?: number; expected: PaymentStatus }[] = [
  { id: "restaurant_success", expected: "succeeded" },
  { id: "hotel_success", productId: "hotel-demo", expected: "succeeded" },
  { id: "no_confirmation", action: "none", expected: "awaiting_confirmation" },
  { id: "tampered_amount", action: "tamper", expected: "awaiting_confirmation" },
  { id: "user_cancel", action: "cancel", expected: "cancelled" },
  { id: "quote_expired", action: "expire", expected: "expired" },
  { id: "risk_limit", limit: 100, expected: "blocked" },
  { id: "reservation_failure", fault: "reserve", expected: "rolled_back" },
  { id: "payment_declined", fault: "decline", expected: "rolled_back" },
  { id: "lost_charge_response", fault: "charge_response_lost", expected: "rolled_back" },
  { id: "fulfillment_failure", fault: "fulfill", expected: "rolled_back" },
  { id: "refund_failure", fault: "refund", expected: "manual_review" },
  { id: "cancel_failure", fault: "cancel", expected: "manual_review" },
  { id: "unknown_payment_status", fault: "reconcile", expected: "manual_review" },
];

export function confirmationFor(intent: PaymentIntent): PaymentConfirmation {
  return { accepted: true, confirmationToken: intent.confirmationToken, amountMinor: intent.quote.amountMinor,
    currency: intent.quote.currency, merchantId: intent.quote.merchantId, quoteVersion: intent.quote.version };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : 0;
}

export function summarizePayments(rows: PaymentCaseResult[]) {
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {
    tasks: rows.length,
    // Fixed fault-suite proportions, NOT production traffic success estimates.
    taskSuccessRate: mean(rows.map(row => Number(row.taskSuccess))),
    humanTakeoverRate: mean(rows.map(row => Number(row.humanTakeover))),
    meanExternalCostCny: mean(rows.map(row => row.externalCostCny)),
    latencyMs: {
      processingMean: mean(rows.map(row => row.processingMs)),
      processingP50: percentile(rows.map(row => row.processingMs), 0.5),
      processingP95: percentile(rows.map(row => row.processingMs), 0.95),
      endToEndP95: percentile(rows.map(row => row.endToEndMs), 0.95),
    },
    expectedBehaviorPass: rows.filter(row => row.expectedBehaviorPass).length,
    costScope: "mock external API/model calls only; excludes principal, hosting and labor",
    latencyScope: "in-process payment workflow only; scripted consent, no LLM planning or human wait",
  };
}

export async function runPaymentBenchmark() {
  const rows: PaymentCaseResult[] = [];
  for (const scenario of CASES) {
    const start = performance.now();
    let now = 1_000;
    const merchant = new MockMerchant(scenario.fault);
    const service = new PaymentService(merchant, { now: () => now, maxAmountMinor: scenario.limit });
    const created = service.create({ sessionId: scenario.id, productId: scenario.productId ?? "restaurant-demo", request: "固定模拟预订请求" });
    let result = created.intent;
    if (scenario.action === "cancel") result = service.cancel(result.id, created.accessToken);
    else if (scenario.action === "expire") { now = result.expiresAt; result = service.get(result.id, created.accessToken); }
    else if (scenario.action === "tamper") {
      try { await service.confirm(result.id, created.accessToken, { ...confirmationFor(result), amountMinor: 1 }); }
      catch { /* Expected rejection; state/ledger invariants below decide pass. */ }
      result = service.get(result.id, created.accessToken);
    } else if (scenario.action !== "none" && result.status === "awaiting_confirmation") {
      result = await service.confirm(result.id, created.accessToken, confirmationFor(result));
    }
    const ledger = await merchant.lookup(result.id).catch(() => undefined);
    const taskSuccess = result.status === "succeeded" && !!result.receipt && !!ledger?.orderId && !!ledger.charged && !ledger.refunded;
    const noChargeExpected = ["awaiting_confirmation", "expired", "cancelled", "blocked"].includes(result.status);
    const safeRollback = result.status !== "rolled_back" || (!ledger?.reserved && (!ledger?.charged || ledger.refunded));
    rows.push({ id: scenario.id, status: result.status, taskSuccess, humanTakeover: result.status === "manual_review",
      expectedBehaviorPass: result.status === scenario.expected && safeRollback
        && (!noChargeExpected || merchant.chargeCount === 0)
        && (scenario.expected !== "succeeded" || taskSuccess),
      externalCostCny: result.externalCostCny, processingMs: result.processingMs, endToEndMs: performance.now() - start });
  }
  return { benchmark: "payment-mock-v1", mode: "mock", summary: summarizePayments(rows), cases: rows };
}
