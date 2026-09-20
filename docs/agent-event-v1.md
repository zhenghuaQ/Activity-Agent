# AgentEvent v1 与 Subscriber 架构

## 目标

Runtime 只产生领域事件，不感知 SSE、HTTP、日志或持久化协议。`AgentEventBus`
只负责把事件分发给多个 Subscriber；每个 Subscriber 自己完成过滤、缓冲、
协议转换和异常处理。

## AgentEvent v1

契约定义在 `spec/agent-event.ts`。`AgentEvent` 是以 `type` 为判别字段的联合类型，
每种事件的 payload 由 `AgentEventPayloadMap` 单独约束。统一信封包含：

- `schemaVersion`: 当前固定为 `1`，用于后续兼容演进；
- `id`: 事件唯一标识；
- `type`: 精确业务事件类型；
- `category`: 便于订阅过滤的稳定粗粒度分类；
- `timestamp`: 事件产生时间；
- `sequence`: 同一个 Run 内从 1 开始单调递增；
- `scope`: `runId`、`sessionId`、`traceId` 三个关联标识；
- `stepId`、`toolName`、`durationMs`: 常用可观测字段；
- `payload`: 由具体事件类型承载的强类型业务数据。

第一版事件类型与分类：

- `lifecycle`: `run_created`、`run_status_changed`、`run_cancel_requested`、
  `run_started`（兼容）、`final`、`error`；
- `planning`: `plan_created`、`profile_resolved`、`replan`；
- `execution`: `step_started`、`step_finished`；
- `tool`: `tool_call`、`tool_result`；
- `evaluation`: `evaluation`；
- `progress`: `stage_update`。

## EventBus 语义

`publish()` 不等待异步副作用完成。同步 Subscriber 空闲时立即执行；
`handle(): void | Promise<void>` 返回 Promise 时，由总线为该 Subscriber
独立串行排队。不同 Subscriber 的异步完成顺序没有保证。重入发布先完成当前事件
的扇出，再发布新事件，避免其他 Subscriber 收到乱序事件。

- `matches()` 必须同步且无副作用；过滤失败只计入 `rejected`，不执行 handle/onError。
- handle 同步抛错或异步 reject：计入 `failed`，调用并等待 `onError()`；其自身失败
  计入 `errorHandlerFailures`。失败后继续下一事件，不自动重试，不改变 Run 状态。
- 默认每个 Subscriber 最多 1024 个待处理事件（含正在执行的一个），构造总线时可调整。
  容量满时拒绝新事件，记录 `rejected` 和 `lastError`，不递归调用错误处理器。
- `subscription.report()` 返回累计交付、失败、拒绝、错误回调失败计数及最后异常；
  `drain(timeoutMs=30000)` 等待该订阅者空闲后返回同一累计报告。报告不因读取而清零。
- `close()` 幂等，停止接收新事件，已接受事件继续处理；推荐先 close 再 await drain。
  drain 超时会 reject，但不会取消副作用或丢弃队列；调用者可再次等待或自行实现 AbortSignal。
- 每次 publish 对匹配的 Subscriber 最多尝试交付一次；重复 publish 不自动去重。
  不保证持久化、Exactly-once 或事务原子性。关键持久化必须由独立存储协议承担。

错误策略是隔离而非静默成功：需要交付保证的调用边界必须检查报告。
SSE Handler 与旧阶段回调入口都在完成返回前 drain 并检查 failed/rejected。
总线仍然不包含 SSE event name，也不感知 HTTP、日志和具体事务。

## 第一批 Subscriber

- `SseAgentEventSubscriber`: 按 `traceId` 过滤，将 `stage_update` 映射为 `stage`，
  其他领域事件映射为 `agent_event`，并观察 `final` 后允许 Handler 发送 `done`；
- `StageUpdateSubscriber`: 兼容旧 `runFullPipelineStreaming` 回调；返回回调 Promise，
  由 EventBus 顺序交付，调用边界检查报告。一次回调失败不阻止后续阶段回调。
- `LoggingAgentEventSubscriber`: 在应用组合根注册，把 lifecycle、画像解析和错误
  事件转换为结构化日志；Runtime 与 Planner 不再直接依赖日志器。

## Run 生命周期

`src/runtime/agent-run.ts` 中的 `AgentRun` 是一次执行的聚合根。它拥有
`AgentState`、生命周期状态机和事件发布能力；`AgentState.status` 对聚合外只读。
聚合校验状态迁移、修改状态，并立即发布对应事件：

1. 创建 Run 时发布 `run_created(status=pending)`；
2. 每次状态变化发布 `run_status_changed(previousStatus, status, reason, source)`；
3. 收到取消信号时先发布 `run_cancel_requested`；
4. 进入 `completed`、`failed` 或 `cancelled` 后发布最终 `final` 结果事件。

合法状态迁移为 `pending → running/failed/cancelled`、
`running → waiting_input/completed/failed/cancelled`、
`waiting_input → running/failed/cancelled`。终态不可
重新进入运行态。

后续日志、指标、审计、持久化或 WebSocket 都应新增独立 Subscriber，而不修改
EventBus 核心。

## 依赖注入

`AgentRuntimeOptions.eventBus` 接收当前 Runtime 使用的 EventBus。Runtime 创建
`AgentRun` 时把该实例绑定到整个 Run，Planner、Executor 和 ToolExecutor 产生的
事件都会发布到同一个注入实例。`defaultAgentEventBus` 只作为应用组合根和旧兼容
入口的默认值，不再是 AgentRuntime 的隐式固定依赖。

## Event Reducer（第二阶段）

`reduceAgentEvent()` 是纯函数，输入上一份 `AgentRunProjection` 与一个已验证事件，
输出新视图。`appendAgentEvent()` 在发布前更新视图，`AgentRun.projection` 暴露它。
`replayAgentEvents()` 接收 JSON/未知输入，经过兼容校验再使用同一 Reducer 重放。

视图包含 scope、最新序号、运行状态、取消标记、计划 ID、当前/并行活动步骤、
规划阶段、重规划次数、错误摘要及 final 状态。DAG 的一个步骤结束不清空其他活动步骤。
同 eventId + sequence 重复交付幂等；ID 序号冲突、倒序、混入其他 Run scope、终态回退
或冲突 final 会抛出错误。事件 ID 被视为稳定身份，不比较同 ID 的 payload 内容。
允许序号间隙，以支持过滤流及跳过未来新增事件；因此视图不证明事件日志完整。

这是运行状态的读视图，不是完整 Event Sourcing：输入、工具返回正文和业务产物
并未完整编码进事件，不能用此视图恢复或继续整个 AgentState。
AgentRun 仍负责业务命令及合法状态迁移，Reducer 不执行 IO 或产生新事件。

## 事件兼容策略（第二阶段）

`spec/agent-event-compat.ts` 的 `decodeAgentEvent(unknown)` 返回三种明确结果：

- `event`：v1 信封、分类、scope、序号、已知 payload 字段通过运行时校验；保留额外字段。
- `ignored`：合法 v1 信封的未知事件类型，可跳过；重放允许它留下的序号间隙。
- `rejected`：畸形信封/payload，或缺失、旧于 v1、未来 schemaVersion。调用方必须报告，
  不把未知版本强制断言为 v1；重放直接抛错。

v1 内只允许新增可选字段、额外 payload 字段及可被旧消费者安全忽略的事件类型。
移除/重命名必填字段、改变类型/语义、扩大影响控制流的状态枚举必须提升版本并提供显式迁移。
`run_started` 继续作为已弃用的 v1 类型读取，Reducer 兼容其启动语义；新生产者继续
使用 `run_status_changed`。没有足够上下文时不伪造 previousStatus 或批量重写历史事件。
当前不提供 v0/v2 迁移器，版本升级时应先增加真实历史 fixture，再实现转换。

## 可靠性补齐（第三阶段）

- finish 先校验终态及结果；重复且结果相同则幂等返回，冲突拒绝且不修改原状态。
  迁移事件经 Reducer 校验后才提交状态。spec/run-lifecycle.ts 为共用规则。
- Reducer 校验 previousStatus；允许序号间隙，但缺失生命周期事件可能无法通过一致性检查。
- spec/decision-response.ts 校验 HTTP/SSE done 的页面消费字段和 stage 结构。
  错误关闭连接并反馈；取消后的迟到事件被忽略。页面增加 ErrorBoundary。
- npm test 包含 jsdom 页面交互测试（图表布局使用替身）；typecheck 同时检查前后端和页面测试。

### 资源限制

通过 AgentRuntimeOptions.limits 配置；默认每实例 maxConcurrentRuns=16、
maxSessionLoops=128，每会话 maxQueuedTurns=32、maxQueuedControls=32，
deadlineMs=120000（从提交起，包括排队）。并发满时直接拒绝；控制队列独立。
超时答复并发出 abort；不合作的底层 Promise 仍占并发额度及会话执行位置直到结束，
不会因超时提前放入新任务。排队取消/超时会移除请求；空闲循环自动回收。
shutdown 后拒绝新提交。这些是单实例限制，不是跨进程分布式配额。

ServerOptions.sseMaxBytes 默认 1 MiB，sseDrainTimeoutMs 默认 10000。
SSE 按顺序写入，write(false) 后等待 drain；超容量/等待超时则关闭连接。
SSE Subscriber 返回写入 Promise，EventBus 的队列上限覆盖慢客户端。
同步 HTTP 容量拒绝返回 429，截止时间到达返回 504；SSE 使用 error 事件反馈。

/api/metrics 新增 runtime（activeRuns/sessions/queued/rejected）与 subscribers
（pending/delivered/failed/rejected/processingMs）；监控页展示积压与失败。
Subscriber 关闭后交付计数仍保留于累计指标；pending 为当前数量，processingMs
为累计处理耗时（含错误回调），不是平均耗时。

### 追问闭环（交互 v1）

- 网页订阅 `/api/decide/stream?interactive=1&q=...`。原有同步接口和未声明 interactive 的 SSE
  保持一次性规划，不等待回答；不支持交互的客户端不会意外挂起。
- Planner 通过 `PipelineOptions.requestFollowUp` 请求输入，不依赖 SSE。Runtime 在当前步骤内等待，
  发布 `run_status_changed(waiting_input)`、`follow_up_requested`；SSE Subscriber 映射成 `follow_up`。
  事件携带 requestId、expiresAt、questions，scope 包含 runId/sessionId/traceId。
- 客户端向 `POST /api/decide/answer` 提交 sessionId/runId/requestId 和
  `answers: [{ questionId, selectedValues: [value] }]`。当前版本只支持单选，必须一次回答全部问题。
  禁止客户端 patches；缺题、重复题、未知题/选项返回 400，不改变等待状态。
- `answer` 是独立控制队列操作，可穿过正在等待的 turn。Runtime 校验会话和一次性随机 requestId，
  发布 `follow_up_answered`（只含 questionIds，不含答案正文），切回 running，唤醒原步骤。
  预算/饮食/减脂回答由领域代码转换为约束补丁，消息历史保留问题与回答；然后运行候选生成等后续步骤，
  不重复解析需求、生成问题或创建新 run。200 仅确认接收，最终结果仍通过原 SSE 的 done 返回。
- 重复回答、错会话、错 run、错 requestId、已取消或过期返回 409。首个合法回答同步认领等待请求，
  并发重试不会执行两次；网络响应丢失时应继续观察原 SSE，不能把 409 理解成新的运行。
- 等待计入原任务默认 120 秒截止时间，仍占一个 maxConcurrentRuns 配额和本会话 turn 位置。
  这是有界的内存等待，不是持久化工作流；断开 SSE、取消、超时、shutdown 都中止并清理等待。
  SSE 交付失败也会中止关联运行；刷新页面/服务重启不能恢复本次任务，需要重新开始。
- 新增事件遵循 v1 加法兼容：旧 decoder 忽略未知类型，新 Reducer 投影 pendingInput；完成/取消时清除。
- 目前可执行的问题目录为预算、老人饮食、减脂程度。LLM 只润色已知问题，不能生成任意补丁。
  既有过敏/忌口不会被“无特殊要求”或“偶尔放纵”清除。年龄/无障碍问题暂不展示，
  因现有地点数据与约束还不足以可靠兑现这些选项；餐饮定制仍需出行前向商家确认。
- requestId 使用随机 UUID 防止猜测；当前系统没有用户认证，这不是账户级授权或跨实例状态同步。
