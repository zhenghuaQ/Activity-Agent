# Activity-Agent 模拟支付演示

当前实现是本地模拟商户，不是支付宝官方沙箱接入。没有真实支付 SDK、支付凭据、网络支付请求或切换 live 的开关。不会发生真实扣款或真实预订。赛事资格和截止日期需另行核实。

## 启动与演示

在仓库根目录执行 `npm run demo:payment`，选择 `restaurant-demo` 或 `hotel-demo`，输入预订需求，然后核对商户、商品、金额、有效期。只有输入完整的“确认模拟付款”才执行；其他输入取消。

故障演示：

- `npm run demo:payment -- --fault=fulfill`：付款后履约失败，自动退款并取消占位。
- `npm run demo:payment -- --fault=charge_response_lost`：扣款已记账但响应丢失，查询账本后退款。
- `npm run demo:payment -- --fault=refund`：退款失败，停在 manual_review。
- `npm run demo:payment -- --fault=reconcile`：支付结果未知，停在 manual_review，不再次扣款。

## 架构与状态

现有 Channel Adapter → PaymentService → MockMerchant。沿用 sessionId，可携带选定 planId 作为关联信息；这些 ID 不代表付款授权。ActivityPlanner / AgentRuntime / Decision Evaluator 的决策语义未修改。本阶段通过结构化商品选择创建付款意图，不自动从自然语言推断付款授权，也没有自动把任意推荐地点映射为可订商户。

正常路径：risk_check → awaiting_confirmation → reserving → paying → fulfilling → succeeded。

风险拒绝：risk_check → blocked。

确认前可 cancelled 或 expired。执行失败后进入 compensating，核对账本、退款、取消预约占位并再次核实；全部完成才是 rolled_back。任何未决情况进入 manual_review。manual_review 是终态，需人工对账；本版不提供人工强制付款或解除拦截接口。

PaymentIntent 保存不可变报价、确认时间、订单凭证和有序状态事件。状态机不依赖 SSE/UI。API/CLI 读取同一状态契约；事件目前保存在 intent 内，未扩展生产 AgentEvent 联合类型或增加自动付款 Subscriber。

演示策略明确为：CNY 整数分、最大 1000 元、报价有效期 5 分钟、固定两个模拟商户。商品价格为虚构展示数据；这不是生产风控阈值或真实商户报价。报价来自服务端固定目录，客户端不能覆盖金额。测试可注入较低限额和时钟。退款为补偿操作，不是跨商户数据库原子事务。

## HTTP 入口

运行 `npm run serve` 后：

- GET /api/payments/catalog：获取固定模拟商品与报价。
- POST /api/payments：body 为 `{ "sessionId": "当前会话", "planId": "可选方案ID", "productId": "restaurant-demo", "request": "预订双人晚餐" }`。返回 intent 和 accessToken。
- GET /api/payments/:id：查询状态。
- POST /api/payments/:id/confirm：明确确认并执行。
- POST /api/payments/:id/cancel：确认执行前取消。

后三个入口均要求 `Authorization: Bearer <accessToken>`。确认 body 必须为：

```json
{
  "accepted": true,
  "confirmationToken": "从 intent 获取，绑定本次报价",
  "amountMinor": 19800,
  "currency": "CNY",
  "merchantId": "mock-restaurant",
  "quoteVersion": 1
}
```

客户端应先展示完整报价，再由用户的确认动作提交以上内容。accessToken 是本次 intent 的访问能力凭据，不是用户登录认证；不要写入 URL 或日志。confirm 重试或并发请求使用同一 intent ID，只执行一次，返回同一结果。重新 POST 创建新的 intent 是另一笔交易，不要在响应丢失时用创建接口代替确认重试。跨会话 token、缺失确认、错金额、过期报价均拒绝。HTTP 不允许注入故障模式或真实支付模式。

## 评测

运行 `npm run eval:payment`。固定 14 个场景，使用相同生产 PaymentService 与模拟账本：餐厅/酒店成功、未确认、篡改金额、取消、过期、限额、占位失败、拒付、扣款响应丢失、履约失败、退款失败、取消失败和账本不可用。

四项指标定义：

1. taskSuccessRate：具有已付款且未退款的有效订单和凭证的任务数 / 全部场景数。回滚、拦截、取消、待确认均不算预订成功。
2. humanTakeoverRate：manual_review 任务数 / 全部场景数。必需的用户确认不属于人工接管。
3. meanExternalCostCny：全部任务外部 API/模型调用费用总和 / 全部任务数，含失败任务；不含订单本金、主机成本和人工成本。本实现没有付费调用，实际为 0，不代表真实上线成本。
4. latencyMs：服务处理时间均值/P50/P95（排除用户等待），以及脚本端到端 P95。端到端范围为支付工作流，脚本即时确认，未覆盖上游规划或真实用户思考时间；生产 intent 保留 createdAt/confirmedAt/completedAt 供计算真实等待耗时。

额外 expectedBehaviorPass 检查每个故障场景状态和账本安全性质。该故障密集集合的 2/14 完成率、3/14 接管率不能推算生产流量分布，也不能与 decision-v3.1 主 benchmark 混为同一指标。原 Decision Benchmark、OpenEvals/LangSmith 接口保持原样；本阶段独立执行支付评测。

## 演示边界

状态、访问凭据、商户账本都只保存在单进程内存中；重启清空，不支持多实例共享、重启恢复或持久化审计。接口是开发演示能力，沿用本项目开发网关；没有支付用户认证、真实库存/日期、支付平台签名验签、回调、真实退款对账或人工处理台。已创建 intent 不自动清理；不应部署为长期公网服务。

未来真实沙箱接入需要单独完成持久化意图/幂等账本、商户协议、超时与异步对账、身份鉴权与交易确认，以及崩溃恢复测试；当前不能通过配置开启真实扣款。
