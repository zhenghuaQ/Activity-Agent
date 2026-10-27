import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { PaymentService } from "./service.js";
import { MockMerchant, type MockFault } from "./mock-merchant.js";

/** Interactive demo uses the exact service used by the HTTP channel. No automatic consent. */
async function main(): Promise<void> {
  const fault = process.argv.find(arg => arg.startsWith("--fault="))?.slice(8) ?? "none";
  const faults: MockFault[] = ["none", "reserve", "decline", "charge_response_lost", "fulfill", "refund", "cancel", "reconcile"];
  if (!faults.includes(fault as MockFault)) throw new Error("unknown_demo_fault");
  const service = new PaymentService(new MockMerchant(fault as MockFault));
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log("Activity-Agent 模拟支付演示：不接真实商户、不产生真实扣款。\n");
    for (const product of service.merchant.catalog()) console.log(`${product.productId}: ${product.description}，¥${(product.amountMinor / 100).toFixed(2)}`);
    const productId = await prompt.question("\n选择商品 ID：");
    const request = await prompt.question("本次预订需求：");
    const { intent, accessToken } = service.create({ sessionId: `payment-demo-${randomUUID()}`, productId, request });
    console.log(`\n商户：${intent.quote.merchantId}\n项目：${intent.quote.description}\n金额：¥${(intent.quote.amountMinor / 100).toFixed(2)} CNY\n报价有效期至：${new Date(intent.expiresAt).toISOString()}\n状态：${intent.status}`);
    if (intent.status !== "awaiting_confirmation") return;
    const answer = await prompt.question("输入“确认模拟付款”提交，其他输入均取消：");
    const result = answer === "确认模拟付款"
      ? await service.confirm(intent.id, accessToken, {
        accepted: true, confirmationToken: intent.confirmationToken,
        amountMinor: intent.quote.amountMinor, currency: intent.quote.currency,
        merchantId: intent.quote.merchantId, quoteVersion: intent.quote.version,
      }) : service.cancel(intent.id, accessToken);
    console.log(JSON.stringify(result, null, 2));
  } finally { prompt.close(); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "demo_failed"); process.exitCode = 1; });
