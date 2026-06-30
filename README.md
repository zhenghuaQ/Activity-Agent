# 🧭 AI出行决策 Agent

**AI Activity Decision Agent** — 一句自然语言 → 一键决策出最优出行方案（景点 + 茶歇 + 餐厅）

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
- **Harness Engineering 评估** — 4 场景用例 + 多维度 Metrics + 自动化 Runner，4/4 通过

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
│   ├── data/              # 数据层（Mock + 高德 Provider）
│   ├── intent/            # 意图解析（Mock关键词匹配）
│   ├── llm/               # LLM集成（OpenAI function calling）
│   ├── profile/           # 用户画像 + 分层 + 存储
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
├── eval/                  # Harness Engineering（场景用例 + 评估）
├── test/                  # 单元测试（13 文件 / 70 用例）
├── DESIGN.md              # 详细设计文档
└── package.json
```

## 快速开始

### 前置要求

- Node.js >= 18
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

# 运行评估套件（4 场景用例自动验证）
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
| Node.js | >= 18 | 运行时（tsx 直接执行 TS） |
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
| `AMAP_KEY` | 否 | 高德地图 Key；缺失走 Mock POI 数据 |
| `PORT` | 否 | 后端端口，默认 3000 |
| `NODE_ENV` | 否 | development / production |

> **零配置可运行**：不配置任何 Key，系统用内置 Mock 数据 + 关键词意图解析完整跑通全链路。

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

## 设计理念

- **先粗筛后精校** — 先用距离+人群标签过滤，再逐项查可用性，避免无效 API 调用
- **用户要最短耗时，不关心拥堵等级** — 拥堵仅用于展示（🟢🟡🔴⛔），方案排序只看绝对耗时
- **SDD + Harness Engineering** — 先定义类型契约，再实现；先建测试用例，再验证

## 技术栈

- **语言**：TypeScript (strict mode)
- **运行时**：Node.js (tsx)
- **后端**：Fastify + OpenAI function calling + Pino
- **前端**：React 18 + Vite + Recharts
- **测试**：Vitest（13 文件 / 70 用例）
- **设计范式**：Specification-Driven Development + Harness Engineering

## License

MIT