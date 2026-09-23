# 🧭 AI出行决策 Agent

**AI Activity Decision Agent** — 通过可持续补充的多轮对话，决策出合适的出行方案（景点 + 茶歇 + 餐厅）

> **产品定位：核心竞争力是「一键决策」**——多维评分 + 可解释 + 个性化推荐。
> 系统**不做下单、预订、取号、支付、配送下单**等交易/履约动作；决策完成后，用户自行在对应平台预订即可。

---

## 项目简介

基于 **LLM + 多 Tool 协同** 的本地短时活动智能**决策** Agent。用户只需用自然语言描述出行需求，系统即可自动完成意图解析、用户画像推理、候选方案生成、可行性校验及精细时间线编排，最终**一键决策**出包含景点、茶歇、餐厅的最优出行方案。

**示例输入：**

> "今天下午是空的，想和老婆孩子出去玩4-6个小时，孩子5岁，老婆最近在减肥，别离家太远，帮我安排下"

**示例输出：**

```
方案: 798艺术区 → 糖果兔儿童乐园 → 望京小腰（轻食版）
时长: 4.8h | 通勤: 16min | 活动: 272min | 得分: 100/100
🎯 14:09→16:39  798艺术区
☕️ 16:48→17:33  糖果兔儿童乐园（室内）
🍽️ 17:40→18:50  望京小腰（轻食版）
```

## 核心特性

- **5 阶段分层递进式决策** — 意图解析 → 追问确认 → 候选生成 → 可行性校验 → 精细编排（决策输出）
- **LeadRole 用户画像体系** — 6 种主导角色（带娃/陪老人/全家/情侣/朋友/独自），自动推理茶歇偏好与忌口
- **拥堵惩罚模型** — 以绝对耗时为核心排序依据（非拥堵等级），拥堵仅用于可视化展示
- **LLM + 降级双保险** — OpenAI function calling 做意图解析，失败自动降级为 Mock 关键词匹配
- **开放地点数据 Provider** — 支持内置 Mock/高德、社区 TypeScript Provider 和语言无关 HTTP Provider
- **真正的多轮规划** — 自由文本补充与选择题追问并存，后续输入只覆盖明确修改的条件
- **会话级短期记忆** — 对话、约束和方案版本持久化，关闭页面后可恢复并继续补充
- **统计化 Eval** — 完整多轮任务达标率为主指标，记忆错误与硬约束违规独立报告，时延按任务做 Bootstrap

## 项目结构

```
ai-activity-agent/
├── spec/                  # SDD 契约层
│   ├── types.ts           # 核心类型定义
│   ├── tools.ts           # 8个决策Tool的输入输出签名
│   ├── constraints.ts     # 约束检查 + 可行性评分
│   ├── decision.ts        # 决策契约（帕累托/评分/可解释）
│   ├── profile.ts         # 画像契约
│   └── transit.ts         # 交通模型（拥堵/路线/惩罚分）
├── src/
│   ├── core/              # 配置/日志/缓存/地理工具
│   ├── data/              # Provider Registry、Mock/高德/HTTP Provider 与合规测试工具
│   ├── intent/            # 意图解析（Mock关键词匹配）
│   ├── llm/               # LLM集成（OpenAI function calling）
│   ├── profile/           # 用户画像 + 分层 + 存储
│   ├── conversation/      # 多轮会话、短期记忆、事件投影与 JSON 存储
│   ├── decision/          # 多维评分 + 帕累托 + 可解释
│   ├── planner/
│   │   ├── engine.ts      # 5阶段一键决策引擎（SSE 流式）
│   │   └── scheduler.ts   # 时间线编排器
│   ├── server/            # Fastify 后端（API/SSE/指标/降级开关/OpenAPI）
│   ├── tools/             # Tool 实现层（仅决策相关，无下单/预订）
│   └── demo.ts            # CLI 交互式 Demo
├── web/                   # 前端看板（Vite + React + TS + Recharts）
│   └── src/pages/         # 决策页 / 监控面板 / 画像管理
├── scripts/
│   └── start.mjs          # 一键启动脚本（跨平台）
├── eval/                  # Decision Eval V3 + Runtime Regression
├── test/                  # 单元与 Runtime 集成测试
├── DESIGN.md              # 详细设计文档
└── package.json
```

## 快速开始

### 前置要求

- Node.js 20.19+（20.x）、22.13+（22.x）或 24+（包含页面测试依赖要求）
- npm >= 9

### 安装

```bash
git clone https://github.com/zhenghuaQ/meituan-activity-agent.git
cd ai-activity-agent
npm install
```

### 配置（可选）

不配置任何 API Key 也能运行，系统将自动使用 Mock 数据。

如需真实 LLM 推理，复制 `.env.example` 为 `.env` 并填入 API Key：

```bash
cp .env.example .env
# 编辑 .env，填入 LLM_API_KEY
```

支持的 LLM 厂商：DeepSeek / 通义千问 / 智谱 GLM / 硅基流动 / 任何 OpenAI 兼容接口。

### 运行

```bash
# 方式一：一键启动（自动检查环境/安装依赖，并行启动前后端）
npm start

# 方式二：分别启动
npm run serve              # 后端 API + SSE 流式决策（:3000）
npm --prefix web run dev   # 前端看板（:5173，Vite proxy 转发到 :3000）
npm run dev:web            # 或用 concurrently 一键并行前后端

# 方式三：CLI 交互式 Demo（终端输入自然语言，获取出行方案）
npm run demo

# 主评测：Decision Agent Evaluation V3（当前为过渡版）
npm run eval:decision

# 工程辅助评测：5-stage baseline vs AgentRuntime
npm run eval:runtime

# 兼容入口：先 Decision，再 Runtime Regression
npm run eval
```

启动后访问：

| 入口 | 地址 | 说明 |
|------|------|------|
| 前端看板 | http://localhost:5173 | 决策页 / 监控面板 / 画像管理 |
| 后端 API | http://localhost:3000 | RESTful + SSE |
| API 文档 | http://localhost:3000/docs | Swagger UI |
| 健康检查 | http://localhost:3000/health | 服务状态 |

## 规划流程

| 阶段 | 名称 | 功能 |
|------|------|------|
| S1 | intent_parsing | LLM + 关键词匹配提取结构化约束 |
| S2 | follow_up_questions | 追问确认（仅在角色需要时触发） |
| S3 | candidate_generation | 并行搜索景点+餐厅+茶歇，组合 ≤4 个候选方案 |
| S4 | feasibility_check | 可用性校验 + 通勤评估 |
| S5 | fine_scheduling | 时间线编排 + 可行性评分 + **一键决策输出最优方案** |

> 决策完成即为终点；系统不执行下单/预订/取号/支付，用户照方案自行预订。

---

## 部署指南

### 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | 20.19+（20.x）、22.13+（22.x）或 24+ | 运行时及测试环境 |
| npm | >= 9 | 包管理 |
| LLM API Key | 可选 | 缺失自动降级 Mock，不阻塞运行 |

### 配置

复制 `.env.example` 为 `.env`，按需填写：

```bash
cp .env.example .env
```

关键配置项：

| 变量 | 必填 | 说明 |
|------|------|------|
| `LLM_API_KEY` | 否 | OpenAI 兼容接口 Key；缺失则走 Mock 关键词解析 |
| `LLM_BASE_URL` | 否 | LLM 服务地址（DeepSeek/通义/GLM 等兼容接口） |
| `LLM_MODEL` | 否 | 模型名，如 `deepseek-chat` |
| `ACTIVITY_DATA_PROVIDER` | 否 | `auto` / `mock` / `amap` / `http` / 已注册的社区 Provider ID |
| `ACTIVITY_DATA_PROVIDER_URL` | HTTP 时必填 | 社区 HTTP Provider 的服务地址 |
| `ACTIVITY_DATA_PROVIDER_TOKEN` | 否 | HTTP Provider 的 Bearer Token，仅由服务端读取 |
| `AMAP_API_KEY` | 高德时必填 | 高德 Provider 的 Web API Key |
| `PORT` | 否 | 后端端口，默认 3000 |
| `NODE_ENV` | 否 | development / production |

> **零配置可运行**：不配置任何 Key，系统用内置 Mock 数据 + 关键词意图解析完整跑通全链路。

### 接入自己的地点数据

Provider 首先把 `city/district` 解析成 `SearchArea`，候选生成再在该区域检索景点、
餐厅和茶歇。目的地不受支持时会明确失败，不会拿其他城市的数据替代。项目同时
提供本地 TypeScript 注册接口、HTTP Provider 协议、来源追踪和黑盒合规测试。
完整契约与示例见 [`docs/data-provider-v1.md`](docs/data-provider-v1.md)。

### 生产构建

```bash
# 后端编译（TS → dist/）
npm run build

# 前端构建（Vite 产物 → web/dist/）
npm run build:web
```

### 生产部署

后端编译后用 node 直接运行产物：

```bash
npm run build
node dist/server/index.js
```

前端为纯静态产物，将 `web/dist/` 部署到任意静态服务器（Nginx / Vercel / CDN），配置反向代理将 `/api` 与 `/health` 转发到后端即可。

Nginx 示例片段：

```nginx
server {
  listen 80;
  root /path/to/web/dist;

  location / { try_files $uri /index.html; }
  location ~ ^/(api|health|openapi) { proxy_pass http://127.0.0.1:3000; }
}
```

### 常见问题排障

| 现象 | 原因 | 解决 |
|------|------|------|
| 前端 5173 打不开 | Vite 未启动 | 确认 `npm start` 或 `npm run dev:web` 已执行 |
| 决策页"连接异常" | 后端 3000 未启动 | 单独 `npm run serve` 看报错日志 |
| 决策卡在意图解析 | LLM Key 无效/超时 | 看后端日志；或监控面板开 `forceMockIntent` 降级 |
| 监控面板全红 | 后端连接失败 | 确认端口 3000 未被占用，重启 `npm run serve` |
| 端口被占用 | 3000/5173 已占 | 改 `PORT` 环境变量 / Vite `server.port` |

---

## 演示教程

### 场景一：带娃家庭出行（核心场景）

**输入**：`带5岁娃和减肥老婆出去玩4-6小时`

**操作**：
1. 打开 http://localhost:5173 ，默认进入「决策」页
2. 输入框已预填示例，点「一键决策」
3. 观察 5 阶段进度条实时推进（意图→追问→候选→校验→编排）
4. 决策完成后查看：
   - **主方案卡片**：时间线（景点→茶歇→餐厅）+ 总分 + 置信度
   - **6 维雷达图**：time/transit/preference/crowd/budget/popularity
   - **帕累托对比**：balanced / time_saver / budget_saver / experience 多方案，点击切换
   - **可解释**：亮点 + 取舍说明

**预期**：推荐 family_first 方案，含儿童友好景点 + 轻食餐厅，预算适中。

### 场景二：陪老人轻松游

**输入**：`陪爸妈逛逛，轻松点，半天时间`，分层选「舒适银发」

**预期**：comfort_senior 方案，少步行、多休息、避免拥挤景点。

### 场景三：降级演示（路演亮点）

**操作**：
1. 切到「监控」页
2. 打开「强制 Mock 意图解析」开关
3. 回「决策」页重新决策
4. 观察：决策仍成功（走关键词解析），监控面板「降级」计数 +1

**预期**：展示系统的降级容错能力——LLM 不可用时仍可输出方案。

---

## 监控指标说明

监控面板（/monitor）每 5s 自动刷新，数据来自 `GET /api/metrics`。

### 核心指标

| 指标 | 字段 | 含义 | 健康判定 |
|------|------|------|----------|
| 总请求 | `requests` | 累计 HTTP 请求数 | — |
| 错误数 | `errors` | 累计 5xx/异常 | 错误率 < 1% 为健康 |
| 决策次数 | `decisions` | 累计决策调用数 | — |
| 降级数 | `degraded` | LLM 失败走 Mock 的次数 | 降级率 < 10% 为健康 |
| 限流拦截 | `rateLimited` | 触发限流的请求数 | 峰值期可接受少量拦截 |
| 平均时延 | `latency.avgMs` | 请求平均耗时 | < 2000ms 为健康 |
| P95 时延 | `latency.p95Ms` | 95 分位耗时 | < 5000ms 为健康 |

### 路由统计

`routes` 按路由维度展示 count / errors / avgMs，用于定位热点与瓶颈路由。

### 运行时降级开关

通过 `POST /api/admin/flags` 可热切换，无需重启：

| 开关 | ON | OFF |
|------|----|----|
| `rateLimit` | 启用限流（默认） | 所有请求放行 |
| `forceMockIntent` | 跳过 LLM，强制关键词解析 | 走正常 LLM 链路 |
| `cache` | 启用缓存 | 关闭缓存 |

> `forceMockIntent` 主要用于路演演示降级策略与 LLM 不可用时的容错验证。

---

## Runtime 架构

`AgentRuntime` 是生产环境唯一执行入口：Channel 请求先标准化为
`Submission`，再由 Session mailbox 串行化同一会话的 Turn，并交给
`ActivityPlanner` 执行。`ActivityPlanner` 是唯一的活动领域编排器；
`runFullPipeline*` 仅作为 deprecated 兼容适配器并委托同一 Planner。

Runtime Plan 使用带 `dependsOn`、`reads`、`writes` 的 DAG 契约并按 Ready
Set 推进；当前执行器仍采用单 Step 串行执行，为后续受限并发保留边界。
重规划只扩展可变的 `searchPolicy.radiusKm`，不会修改用户原始距离约束。

Session 存储设有会话数、闲置时间和消息数上限；未提供 Session ID 的
HTTP 请求使用完成后释放的临时会话。取消信号从 HTTP/SSE 断开一路传播到
LLM、Tool、数据 Provider 和通勤 I/O，取消不会被转换成 Mock/fallback。
Eval 的 Runtime 对照组直接通过 `AgentRuntime` 运行，不经过兼容 API。

Runtime 内部统一发布传输无关的 `AgentEvent v1`。事件信封包含版本、分类、
类型、Run 内序号和 run/session/trace 关联信息。`AgentEventBus` 只按注册顺序
把事件扇出给匹配的 Subscriber，并隔离单个 Subscriber 的异常；SSE 映射、
旧阶段回调等具体事务分别由对应 Subscriber 处理，EventBus 不依赖任何传输协议。
Run 状态只能通过生命周期状态机迁移，每次创建、状态变化和取消请求都会发布
事件；结构化日志也由应用层 Logging Subscriber 生成，Runtime/Planner 不直接
依赖日志实现。`AgentRun` 聚合拥有状态和事件发布能力，EventBus 通过
`AgentRuntimeOptions` 注入；每种事件的 payload 都按 `type` 提供独立 TypeScript
契约。
详细契约见 [`docs/agent-event-v1.md`](docs/agent-event-v1.md)。

会话短期记忆同样通过独立 `ConversationMemorySubscriber` 消费 Runtime 事件：
意图解析完成后立即保存约束，方案完成后保存不可变版本，用户可确认任一帕累托
候选。前端把当前 conversation ID 保存在浏览器本地，并通过
`GET /api/conversations/:id` 恢复对话。默认存储文件为
`data/conversations.json`；它只保存当前会话事实，不做跨会话长期画像推断。

## 测试追问交互

运行 `npm run dev:web`（若已有旧服务，请先重启），打开开发页面，输入
“带5岁娃和减肥老婆出去玩4-6小时”，点击“一键决策”。出现追问后，为每题选择答案，
点击“提交回答，继续规划”：系统会更新约束并继续同一次运行，不重新解析输入。
预算用于评分偏好；减脂选项影响餐厅筛选；已说明的忌口始终保留。

追问期间可中止；默认任务总截止时间为 120 秒，包含排队、执行和等待回答。
当前支持旅行风格、预算、饮食和减脂等单选问题，也允许用户在任意方案后继续
输入自然语言补充或纠正。刷新/关闭页面会中止正在等待的 Runtime 运行，但已解析
约束会保存在当前会话；重新打开后可直接继续补充，无需重述此前条件。
网页会自动启用 `interactive=1`；旧同步 API 和未启用交互的 SSE 保持原行为。
接口及取消/重试语义见 `docs/agent-event-v1.md` 的“追问闭环”。

## 多轮 Eval 口径

- 主指标：完整多轮任务是否成功产出可选择方案，使用任务级 Wilson 95% 区间。
- 独立约束指标：发生记忆错误的任务比例、发生硬约束违规的任务比例；同时展示原始检查数。
- 辅助指标：候选方案对显式偏好的覆盖率、总时延和 Tool 调用数；时延使用任务级 Bootstrap，版本对比采用同任务配对差值。
- 同一会话中的 turn/check 不视作独立样本，避免人为放大样本量。当前内置用例属于开发集；上线门禁前仍需扩充并冻结代表性 holdout。

## 设计理念

- **先粗筛后精校** — 先用距离+人群标签过滤，再逐项查可用性，避免无效 API 调用
- **用户要最短耗时，不关心拥堵等级** — 拥堵仅用于展示（🟢🟡🔴⛔），方案排序只看绝对耗时
- **SDD + Harness Engineering** — 先定义类型契约，再实现；先建测试用例，再验证

## 技术栈

- **语言**：TypeScript (strict mode)
- **运行时**：Node.js (tsx)
- **后端**：Fastify + OpenAI function calling + Pino
- **前端**：React 18 + Vite + Recharts
- **测试**：Vitest（单元、Runtime 生命周期、HTTP/SSE 与 Eval 集成测试）
- **设计范式**：Specification-Driven Development + Harness Engineering

## License

MIT
