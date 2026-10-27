import { describe, expect, it } from "vitest";
import { PaymentService } from "../src/payment/service.js";
import { MockMerchant, type MockFault } from "../src/payment/mock-merchant.js";
import { confirmationFor, runPaymentBenchmark, summarizePayments } from "../eval/payment/benchmark.js";
import { buildServer } from "../src/server/app.js";

const request = { sessionId: "conversation-1", planId: "selected-plan-1", productId: "restaurant-demo", request: "帮我预订双人晚餐" };

describe("mock payment state machine", () => {
  it("requires explicit quote-bound consent and does not reserve/charge on create", async () => {
    const merchant = new MockMerchant();
    const service = new PaymentService(merchant);
    const { intent, accessToken } = service.create(request);
    expect(intent.status).toBe("awaiting_confirmation");
    expect(intent.sessionId).toBe(request.sessionId);
    expect(intent.planId).toBe(request.planId);
    expect(await merchant.lookup(intent.id)).toBeUndefined();
    for (const patch of [
      { accepted: false }, { accepted: "true" }, { amountMinor: 1 }, { currency: "USD" },
      { merchantId: "other" }, { quoteVersion: 2 }, { confirmationToken: "wrong" },
    ]) {
      await expect(service.confirm(intent.id, accessToken, { ...confirmationFor(intent), ...patch } as never)).rejects.toThrow("explicit_quote_confirmation_required");
    }
    expect(merchant.chargeCount).toBe(0);
    const result = await service.confirm(intent.id, accessToken, confirmationFor(intent));
    expect(result.status).toBe("succeeded");
    expect(result.receipt).toMatchObject({ mode: "mock", amountMinor: 19800, currency: "CNY" });
    expect(result.events.map(event => event.status)).toEqual(["risk_check", "awaiting_confirmation", "reserving", "paying", "fulfilling", "succeeded"]);
  });

  it("serializes duplicate concurrent confirmations and never charges twice", async () => {
    const merchant = new MockMerchant();
    const service = new PaymentService(merchant);
    const { intent, accessToken } = service.create(request);
    const results = await Promise.all(Array.from({ length: 10 }, () => service.confirm(intent.id, accessToken, confirmationFor(intent))));
    expect(new Set(results.map(result => result.receipt?.paymentId)).size).toBe(1);
    expect(merchant.chargeCount).toBe(1);
    await service.confirm(intent.id, accessToken, confirmationFor(intent));
    expect(merchant.chargeCount).toBe(1);
    results[0].quote.amountMinor = 1;
    expect(service.get(intent.id, accessToken).quote.amountMinor).toBe(19800);
  });

  it("protects snapshots and intent capabilities across sessions and service instances", async () => {
    const service = new PaymentService();
    const a = service.create(request);
    const b = service.create({ ...request, sessionId: "other-session" });
    a.intent.quote.amountMinor = 1;
    expect(service.get(a.intent.id, a.accessToken).quote.amountMinor).toBe(19800);
    expect(() => service.get(a.intent.id, b.accessToken)).toThrow("payment_not_found");
    await expect(service.confirm(a.intent.id, b.accessToken, confirmationFor(b.intent))).rejects.toThrow("payment_not_found");
    expect(() => new PaymentService().get(a.intent.id, a.accessToken)).toThrow("payment_not_found");
    expect(a.intent.confirmationToken).not.toBe(b.intent.confirmationToken);
  });

  it("expires quotes at the exact deadline, supports cancellation, and enforces risk limit", async () => {
    let now = 100;
    const service = new PaymentService(new MockMerchant(), { now: () => now, confirmationTtlMs: 10 });
    const expired = service.create(request);
    now = 110;
    await expect(service.confirm(expired.intent.id, expired.accessToken, confirmationFor(expired.intent))).rejects.toThrow("expired");
    const cancelled = service.create(request);
    expect(service.cancel(cancelled.intent.id, cancelled.accessToken).status).toBe("cancelled");
    await expect(service.confirm(cancelled.intent.id, cancelled.accessToken, confirmationFor(cancelled.intent))).rejects.toThrow("cancelled");
    const risk = new PaymentService(new MockMerchant(), { maxAmountMinor: 100 });
    const blocked = risk.create(request);
    expect(blocked.intent.status).toBe("blocked");
    await expect(risk.confirm(blocked.intent.id, blocked.accessToken, confirmationFor(blocked.intent))).rejects.toThrow("blocked");
    expect(service.merchant.chargeCount + risk.merchant.chargeCount).toBe(0);
  });

  it.each<MockFault>(["reserve", "decline", "charge_response_lost", "fulfill"])("compensates %s without outstanding funds or reservations", async fault => {
    const merchant = new MockMerchant(fault);
    const service = new PaymentService(merchant);
    const { intent, accessToken } = service.create(request);
    const result = await service.confirm(intent.id, accessToken, confirmationFor(intent));
    expect(result.status).toBe("rolled_back");
    expect(result.receipt).toBeUndefined();
    const ledger = await merchant.lookup(intent.id);
    expect(ledger?.reserved ?? false).toBe(false);
    expect(ledger?.charged && !ledger.refunded).toBeFalsy();
    if (fault === "charge_response_lost" || fault === "fulfill") expect(merchant.refundCount).toBe(1);
    await service.confirm(intent.id, accessToken, confirmationFor(intent));
    expect(merchant.chargeCount).toBeLessThanOrEqual(1);
  });

  it.each<MockFault>(["refund", "cancel", "reconcile"])("escalates unresolved %s and cannot re-enter payment", async fault => {
    const merchant = new MockMerchant(fault);
    const service = new PaymentService(merchant);
    const { intent, accessToken } = service.create(request);
    const result = await service.confirm(intent.id, accessToken, confirmationFor(intent));
    expect(result.status).toBe("manual_review");
    expect(result.receipt).toBeUndefined();
    expect((await service.confirm(intent.id, accessToken, confirmationFor(intent))).status).toBe("manual_review");
    expect(merchant.chargeCount).toBe(1);
  });

  it("cannot cancel after processing starts", async () => {
    const service = new PaymentService();
    const { intent, accessToken } = service.create(request);
    const pending = service.confirm(intent.id, accessToken, confirmationFor(intent));
    expect(() => service.cancel(intent.id, accessToken)).toThrow("not_cancellable");
    await pending;
  });

  it("rejects invalid inputs and invalid risk configuration", () => {
    const service = new PaymentService();
    expect(() => service.create({ ...request, productId: "external-merchant" })).toThrow("unknown_product");
    expect(() => service.create({ ...request, sessionId: "" })).toThrow("invalid_request");
    expect(() => service.create({ ...request, planId: 123 } as never)).toThrow("invalid_plan_id");
    expect(() => new PaymentService(new MockMerchant(), { maxAmountMinor: NaN })).toThrow("invalid_payment_policy");
  });
});

describe("payment HTTP channel", () => {
  it("demonstrates catalog -> intent -> authenticated confirmation -> order/receipt", async () => {
    const app = buildServer();
    try {
      const catalog = await app.inject({ method: "GET", url: "/api/payments/catalog" });
      expect(catalog.json().mode).toBe("mock");
      const created = await app.inject({ method: "POST", url: "/api/payments", payload: request });
      expect(created.statusCode).toBe(200);
      const { intent, accessToken } = created.json();
      const url = `/api/payments/${intent.id}`;
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
      const headers = { authorization: `Bearer ${accessToken}` };
      const missingConsent = await app.inject({ method: "POST", url: `${url}/confirm`, headers, payload: {} });
      expect(missingConsent.statusCode).toBe(400);
      const paid = await app.inject({ method: "POST", url: `${url}/confirm`, headers, payload: confirmationFor(intent) });
      expect(paid.statusCode).toBe(200);
      expect(paid.json().status).toBe("succeeded");
      expect(paid.json().receipt.orderId).toMatch(/^mock-order-/);
      expect(paid.headers["cache-control"]).toBe("no-store");
      const read = await app.inject({ method: "GET", url, headers });
      expect(read.json().receipt).toEqual(paid.json().receipt);
      const duplicate = await app.inject({ method: "POST", url: `${url}/confirm`, headers, payload: confirmationFor(intent) });
      expect(duplicate.json().receipt).toEqual(paid.json().receipt);
      for (const payload of [null, {}, { ...request, amountMinor: 1 }, { ...request, mode: "live" }, { ...request, fault: "refund" }]) {
        expect((await app.inject({ method: "POST", url: "/api/payments", headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) })).statusCode).toBe(400);
      }
    } finally { await app.close(); }
  });
});

describe("payment evaluation metrics", () => {
  it("keeps task success distinct from safety correctness and measures takeover without counting confirmation", async () => {
    const result = await runPaymentBenchmark();
    expect(result.summary.tasks).toBe(14);
    expect(result.summary.expectedBehaviorPass).toBe(14);
    expect(result.summary.taskSuccessRate).toBe(2 / 14);
    expect(result.summary.humanTakeoverRate).toBe(3 / 14);
    expect(result.summary.meanExternalCostCny).toBe(0);
    expect(result.summary.latencyMs.processingP95).toBeGreaterThanOrEqual(0);
    expect(result.cases.find(row => row.id === "no_confirmation")?.humanTakeover).toBe(false);
    const again = await runPaymentBenchmark();
    const semantics = (value: typeof result) => value.cases.map(({ id, status, taskSuccess, humanTakeover, expectedBehaviorPass }) => ({ id, status, taskSuccess, humanTakeover, expectedBehaviorPass }));
    expect(semantics(again)).toEqual(semantics(result));
  });

  it("computes metrics from all tasks including failures, and costs exclude transaction principal", () => {
    const row = { id: "a", status: "succeeded" as const, taskSuccess: true, humanTakeover: false, expectedBehaviorPass: true, externalCostCny: 0.02, processingMs: 10, endToEndMs: 100 };
    const report = summarizePayments([row, { ...row, id: "b", taskSuccess: false, humanTakeover: true, externalCostCny: 0.04, processingMs: 30, endToEndMs: 200 }]);
    expect(report.taskSuccessRate).toBe(0.5);
    expect(report.humanTakeoverRate).toBe(0.5);
    expect(report.meanExternalCostCny).toBeCloseTo(0.03);
    expect(report.latencyMs).toEqual({ processingMean: 20, processingP50: 10, processingP95: 30, endToEndP95: 200 });
  });
});
