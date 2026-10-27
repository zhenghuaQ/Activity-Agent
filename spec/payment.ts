/** Mock-only payment contract. Amounts are integer minor units, never floats. */
export type PaymentStatus = "risk_check" | "awaiting_confirmation" | "blocked" | "expired"
  | "cancelled" | "reserving" | "paying" | "fulfilling" | "succeeded"
  | "compensating" | "rolled_back" | "manual_review";

export interface PaymentQuote {
  productId: string;
  merchantId: string;
  description: string;
  amountMinor: number;
  currency: "CNY";
  version: 1;
}

export interface PaymentConfirmation {
  accepted: true;
  confirmationToken: string;
  amountMinor: number;
  currency: "CNY";
  merchantId: string;
  quoteVersion: 1;
}

export interface PaymentEvent {
  sequence: number;
  at: number;
  status: PaymentStatus;
  reason: string;
}

export interface PaymentIntent {
  id: string;
  mode: "mock";
  sessionId: string;
  /** Correlation only: a plan ID is not payment authorization. */
  planId?: string;
  request: string;
  quote: PaymentQuote;
  status: PaymentStatus;
  confirmationToken: string;
  expiresAt: number;
  createdAt: number;
  confirmedAt?: number;
  completedAt?: number;
  receipt?: { orderId: string; paymentId: string; amountMinor: number; currency: "CNY"; mode: "mock" };
  events: PaymentEvent[];
  /** Measured service processing, excludes user confirmation waiting time. */
  processingMs: number;
  /** External API/model spend, excluding purchase principal. Mock makes no paid calls. */
  externalCostCny: number;
}
