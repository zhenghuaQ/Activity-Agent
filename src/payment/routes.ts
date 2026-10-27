import type { ChannelRequest, ChannelResponse, ChannelRoute } from "../../spec/channel.js";
import type { PaymentConfirmation } from "../../spec/payment.js";
import { PaymentError, PaymentService } from "./service.js";

function objectBody(req: ChannelRequest): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new PaymentError("invalid_body", 400);
  return req.body as Record<string, unknown>;
}

/** Payment routes use capabilities issued at intent creation. These are demo access controls,
 * not user authentication. Neither sessionId nor planId grants access to an existing intent.
 */
export function buildPaymentRoutes(service = new PaymentService()): ChannelRoute[] {
  const wrap = (handler: (req: ChannelRequest) => unknown | Promise<unknown>) => async (req: ChannelRequest): Promise<ChannelResponse> => {
    try {
      return { body: await handler(req), headers: { "Cache-Control": "no-store" } };
    } catch (error) {
      if (error instanceof PaymentError) return { statusCode: error.statusCode, body: { error: error.code, mode: "mock" }, headers: { "Cache-Control": "no-store" } };
      throw error;
    }
  };
  const token = (req: ChannelRequest): string => {
    const header = req.headers.authorization;
    return typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  };
  return [
    { method: "GET", path: "/api/payments/catalog", handler: wrap(() => ({ mode: "mock", products: service.merchant.catalog() })) },
    { method: "POST", path: "/api/payments", handler: wrap(req => {
      const body = objectBody(req);
      if (Object.keys(body).some(key => !["sessionId", "productId", "request", "planId"].includes(key))) throw new PaymentError("unsupported_field", 400);
      return service.create(body as unknown as Parameters<PaymentService["create"]>[0]);
    }) },
    { method: "GET", path: "/api/payments/:id", handler: wrap(req => service.get(req.params.id, token(req))) },
    { method: "POST", path: "/api/payments/:id/confirm", handler: wrap(req => service.confirm(req.params.id, token(req), objectBody(req) as unknown as PaymentConfirmation)) },
    { method: "POST", path: "/api/payments/:id/cancel", handler: wrap(req => service.cancel(req.params.id, token(req))) },
  ];
}
