# AI出行决策 Agent — 设计文档

## 一、概述

本地场景短时活动**智能决策** Agent，接受自然语言输入，**一键决策**输出包含景点、茶歇、餐厅的最优出行方案。

> **产品定位**：核心竞争力是「一键决策」（多维评分 + 可解释 + 个性化推荐）。
> 系统不做下单、预订、取号、支付、配送等交易/履约动作；决策完成即为流程终点。

技术栈：TypeScript + Node.js (tsx 运行时) + Fastify + React + Vite
设计范式：Specification-Driven Development (SDD) + Harness Engineering

## 二、Planning 策略

采用 **分层递进式决策（Hierarchical Progressive Planning）**，共 5 阶段：

| 阶段 | 名称 | 功能 | 输入 → 输出 |
|------|------|------|-------------|
| S1 | intent_parsing | LLM（OpenAI function calling）+ 关键词兜底 | 自然语言 → StructuredConstraints |
| S2 | follow_up_questions | 追问确认（仅 needsFollowUp 角色） | Constraints → FollowUpQuestion[] |
| S3 | candidate_generation | 并行搜索景点+餐厅+茶歇，组合候选方案 | Constraints → PlanCandidate[] (≤4) |
| S4 | feasibility_check | 可用性校验 + 通勤评估 + 过滤 | Candidates → ValidCandidates |
| S5 | fine_scheduling | 多维评分 + 帕累托多方案 + 可解释输出 | Candidates → DecisionResult |

**设计考量**：
- 先粗筛后精校：先用距离+人群标签过滤，再逐个查可用性，避免无效 API 调用
- 追问仅触发于 `needsFollowUp=true` 的角色（kids/elderly），避免过度交互
- S3 并行搜索 3 种地点类型，提高响应速度
- LLM 解析失败自动降级为关键词匹配，保证可用性

## 三、多维评分体系（M2）

6 维度归一化到 0-100，按可配置权重加权：

| 维度 | 说明 | 调权情境 |
|------|------|----------|
| time | 窗口利用率 | — |
| transit | 通勤效率 | 雨雪/高峰抬高 |
| preference | 偏好契合（菜系/忌口/特色） | — |
| crowd | 人群适配（标签+拥挤度） | 周末/敏感人群抬高 |
| budget | 预算契合 | — |
| popularity | 口碑热度 | — |

- 权重可通过画像（M3）或情境（context）覆盖
- 帕累托多方案：balanced / time_saver / budget_saver / experience
- 每个维度附带 reason 字段，确保可解释

## 四、用户画像体系（M3）

- **LeadRole**：6 种主导角色（kids / elderly / mixed_family / partner / friends_group / solo_relax）
- **分层（Segment）**：根据约束自动推断画像分层
- **个性化**：画像权重 × 默认权重先验 → 归一化 → 影响最终排序

## 五、异常处理

| 异常 | 处理策略 |
|------|----------|
| LLM API 不可用/超时 | 自动降级为关键词匹配 |
| 高德 API 不可用 | 降级为 Mock 通勤估算 |
| 候选方案不足 | L1 扩搜索半径 → L2 放宽人群标签 |
| 所有候选不可行 | 返回最高可行性分方案 + 降级说明 |
| 运行时降级 | `/api/admin/flags` 热切换 forceMockIntent / rateLimit / cache |

## 六、项目结构

```
ai-activity-agent/
├── spec/                     # SDD 契约层（类型定义 + 常量 + 约束规则）
│   ├── types.ts              # 核心类型（Group/Plan/Activity/Trace/ToolResult）
│   ├── tools.ts              # 8 个决策 Tool 的输入输出签名
│   ├── tool-data.ts           # Tool 返回数据类型（替代 as any）
│   ├── constraints.ts        # 约束检查规则 + 时间工具函数
│   ├── decision.ts           # 决策类型 + 维度定义 + 默认权重常量
│   ├── datasource.ts         # 数据源抽象类型
│   ├── profile.ts            # 画像类型
│   ├── transit.ts            # 交通模型类型 + Mock 算法
│   └── index.ts
├── src/
│   ├── core/                 # 基础设施
│   │   ├── config.ts         # 应用配置（环境变量 + 单例）
│   │   ├── logger.ts         # pino 结构化日志
│   │   ├── cache.ts          # 内存缓存
│   │   └── geo.ts            # 地理计算工具
│   ├── data/                 # 数据层
│   │   ├── mock.ts           # Mock 数据集
│   │   ├── crowd.ts          # 拥挤度预测（启发式）
│   │   ├── crowd-constants.ts # 拥挤度参数常量
│   │   ├── index.ts          # 数据源工厂
│   │   └── providers/        # 数据 Provider（Amap / Mock）
│   ├── llm/                  # LLM 集成
│   │   ├── config.ts         # LLM 客户端配置
│   │   ├── intent.ts         # OpenAI function calling 意图解析
│   │   └── followup.ts       # LLM 追问生成
│   ├── intent/               # 意图解析（降级方案）
│   │   └── parser.ts         # 关键词匹配兜底
│   ├── profile/              # 用户画像
│   │   ├── profile.ts        # 画像派生逻辑
│   │   ├── segments.ts       # 分层定义
│   │   ├── store.ts          # 画像存储
│   │   └── index.ts
│   ├── decision/             # 决策引擎
│   │   ├── index.ts          # runDecision 入口
│   │   ├── score.ts          # 6 维评分
│   │   ├── constants.ts      # 评分参数常量
│   │   ├── context.ts        # 情境感知调权
│   │   ├── feasibility.ts    # 可行性评分 + 排序
│   │   ├── weights.ts        # 权重归一化
│   │   ├── pareto.ts         # 帕累托多方案生成
│   │   ├── explain.ts        # 可解释输出
│   │   └── fallback.ts       # 兜底逻辑
│   ├── planner/              # 管线编排
│   │   ├── engine.ts         # 5 阶段一键决策引擎（含 SSE 流式）
│   │   └── scheduler.ts      # 时间线编排器
│   ├── server/               # Fastify 网关
│   │   ├── index.ts          # 服务入口
│   │   ├── app.ts            # 路由注册
│   │   ├── metrics.ts        # 指标采集
│   │   ├── flags.ts          # 运行时降级开关
│   │   ├── ratelimit.ts      # 限流
│   │   ├── openapi.ts        # OpenAPI 规范生成
│   │   └── swagger-html.ts   # Swagger UI 页面模板
│   ├── tools/                # Tool 实现层（8 个决策 Tool）
│   ├── transit/              # 高德 Directions API 集成
│   └── demo.ts               # CLI 交互式 Demo
├── web/                      # 前端看板（Vite + React + TypeScript + Recharts）
│   └── src/pages/            # 决策页 / 监控面板 / 画像管理
├── eval/                     # Harness Engineering（4 场景用例 + 评估 Runner）
├── test/                     # 单元测试
├── scripts/start.mjs         # 一键启动脚本
├── README.md
└── package.json
```

## 七、后续扩展方向

- 增加天气 API → 动态调整室内/室外景点权重
- 替换 Mock 数据为真实 LBS 数据源
- 增加历史决策记录与用户反馈闭环
