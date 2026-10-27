import type { PaymentQuote } from "../../spec/payment.js";

export type MockFault = "none" | "reserve" | "decline" | "charge_response_lost"
  | "fulfill" | "refund" | "cancel" | "reconcile";

const CATALOG: PaymentQuote[] = [
  { productId: "restaurant-demo", merchantId: "mock-restaurant", description: "模拟餐厅：双人预约套餐（非真实预订）", amountMinor: 19800, currency: "CNY", version: 1 },
  { productId: "hotel-demo", merchantId: "mock-hotel", description: "模拟酒店：一晚住宿（非真实预订）", amountMinor: 59900, currency: "CNY", version: 1 },
];

interface LedgerEntry { reserved: boolean; charged: boolean; refunded: boolean; orderId?: string }

/** In-process merchant/payment ledger; every operation is idempotent by intent ID. No network. */
export class MockMerchant {
  private ledger = new Map<string, LedgerEntry>();
  readonly mode = "mock" as const;
  chargeCount = 0;
  refundCount = 0;

  constructor(private readonly fault: MockFault = "none") {}

  catalog(): PaymentQuote[] { return structuredClone(CATALOG); }

  quote(productId: string): PaymentQuote {
    const quote = CATALOG.find(item => item.productId === productId);
    if (!quote) throw new Error("unknown_product");
    return structuredClone(quote);
  }

  async reserve(id: string): Promise<void> {
    if (this.fault === "reserve") throw new Error("reservation_unavailable");
    if (!this.ledger.has(id)) this.ledger.set(id, { reserved: true, charged: false, refunded: false });
  }

  async charge(id: string): Promise<string> {
    const entry = this.ledger.get(id);
    if (!entry?.reserved) throw new Error("reservation_required");
    if (this.fault === "decline") throw new Error("payment_declined");
    if (!entry.charged) { entry.charged = true; this.chargeCount++; }
    if (this.fault === "charge_response_lost" || this.fault === "reconcile") throw new Error("payment_response_lost");
    return `mock-payment-${id}`;
  }

  async fulfill(id: string): Promise<string> {
    if (["fulfill", "refund", "cancel"].includes(this.fault)) throw new Error("fulfillment_failed");
    const entry = this.ledger.get(id);
    if (!entry?.charged || entry.refunded) throw new Error("payment_required");
    entry.orderId ??= `mock-order-${id}`;
    return entry.orderId;
  }

  async lookup(id: string): Promise<LedgerEntry | undefined> {
    if (this.fault === "reconcile") throw new Error("ledger_unavailable");
    return structuredClone(this.ledger.get(id));
  }

  async refund(id: string): Promise<void> {
    if (this.fault === "refund") throw new Error("refund_failed");
    const entry = this.ledger.get(id);
    if (entry?.charged && !entry.refunded) { entry.refunded = true; this.refundCount++; }
  }

  async cancel(id: string): Promise<void> {
    if (this.fault === "cancel") throw new Error("reservation_cancel_failed");
    const entry = this.ledger.get(id);
    if (entry) entry.reserved = false;
  }
}
