# Decision Agent Evaluation V3

## 定位

Decision Eval 是本项目的主评测。它评估用户需求是否经过多轮对话被正确理解、保留、修正并最终收敛为可接受的决策结果。

当前目录已经建立 Decision Benchmark V3 的数据集骨架。场景是可序列化的 `DecisionScenario`，包含多轮用户输入、环境事实、独立的合成地点数据 fixture、期望约束/偏好以及适应性期望。每个场景明确声明 `expectedFeasibility`。

Decision Task Success 表示“是否完成 Scenario 要求的正确决策目标”，不表示“是否输出了 Plan”。当场景没有任何满足硬约束的方案时，Runtime 正常走完决策流程并正确不输出方案，也算成功。工具、Provider 或 Runtime 执行失败不会被算成正确的无方案结果。

每个运行结果单独报告 `outcome`、`runtimeCompleted` 和 `planGenerated`。Outcome 区分 `feasible_plan`、`no_feasible_plan`、`invalid_plan`、`missed_feasible_plan` 和 `runtime_failure`。只有 `feasible_plan` 对应可行场景成功，只有 `no_feasible_plan` 对应不可行场景成功。不可行场景的 fixture 会在评测前按景点/餐厅候选、目的地、硬距离和硬饮食限制做必要可行性校验；正常无方案还要求决策步骤全部结束，且没有工具错误或 Runtime 错误。

当前 benchmark 版本为 `decision-v3.0`，首批包含 12 个场景，覆盖情侣、家庭、儿童、老年人、朋友、独自出行、偏好修改、约束保留和无可行方案等情况。上海场景使用显式的 synthetic fixture，并通过每个场景独立的 Provider/Location Resolver 运行，不依赖真实地图服务。

Runtime Regression 是工程辅助评测，保留旧的 5-stage baseline 与 AgentRuntime 对照，用来发现 Runtime、ToolExecutor、Trace、生命周期和重规划相关回归。它不再代表 Decision Agent 的主 benchmark。

出行只是当前使用的 benchmark domain。新的评测抽象不命名为 TravelEval；未来可以在同一套 Decision Eval 契约下增加其他活动或决策 domain。

## 未来关注的主指标

后续 Decision Eval 将逐步覆盖：

- constraint satisfaction：硬性约束满足度
- preference alignment：用户偏好与最终方案的一致性
- adaptation quality：用户补充、修改和纠正需求后的适应质量
- decision quality：最终方案的整体决策质量
- regret：用户确认或反馈后的后悔度

这些指标目前并未全部实现。本阶段已有的是任务级多轮达标率、Memory 错误、硬约束违反、偏好覆盖和延迟等过渡指标。

## 运行入口

```bash
# 主评测：Decision Agent Evaluation V3
npm run eval:decision

# 工程辅助：5-stage baseline vs AgentRuntime
npm run eval:runtime

# 兼容入口：先 Decision，再 Runtime Regression
npm run eval
```

评测以任务为主要抽样单位；对话中的 turn 和检查项不是相互独立的样本。统计区间使用现有 Wilson 与任务级 bootstrap 实现，位于 `eval/shared/statistics.ts`。
