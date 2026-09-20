// ============================================================
// src/server/openapi.ts — OpenAPI 3.0 文档（手写，零依赖）
//
// 仅描述对外契约，作为前端联调与交付物的一部分；
// 由 /openapi.json 提供，/docs 用 CDN 版 Swagger UI 渲染。
// ============================================================

export function getOpenApiSpec(version: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "AI出行决策 API",
      version,
      description:
        "AI 智能出行/活动决策引擎。仅决策，不做任何下单/支付/履约。支持同步决策与 SSE 流式决策。",
    },
    servers: [{ url: "/", description: "当前服务" }],
    paths: {
      "/health": {
        get: {
          summary: "健康检查",
          responses: { "200": { description: "服务状态与特性开关" } },
        },
      },
      "/api/decide": {
        post: {
          summary: "同步一键决策",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DecideRequest" },
              },
            },
          },
          responses: {
            "200": { description: "决策结果（首推 + 帕累托多方案 + 可解释）" },
            "400": { description: "参数错误" },
            "429": { description: "触发限流或任务容量已满" },
            "504": { description: "任务超过截止时间（包含排队）" },
          },
        },
      },
      "/api/decide/stream": {
        get: {
          summary: "SSE 流式决策（实时推送 5 阶段过程）",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" }, description: "自然语言需求" },
            { name: "segment", in: "query", required: false, schema: { type: "string" }, description: "用户分层" },
            { name: "weather", in: "query", required: false, schema: { type: "string" } },
            { name: "sessionId", in: "query", required: false, schema: { type: "string" }, description: "可恢复会话 ID；后续请求复用该值以继承短期记忆" },
            { name: "interactive", in: "query", schema: { type: "string", enum: ["0", "1"], default: "0" }, description: "1 启用追问：等待 answer 接口提交后继续原运行" },
          ],
          responses: { "200": { description: "text/event-stream，事件：stage / follow_up / agent_event / done / error。follow_up 包含 requestId/runId/sessionId/expiresAt/questions；等待计入任务截止时间。" } },
        },
      },
      "/api/decide/answer": {
        post: {
          summary: "提交全部追问答案，继续原运行（通过原 SSE 返回结果）",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["sessionId", "runId", "requestId", "answers"], properties: {
              sessionId: { type: "string" }, runId: { type: "string" }, requestId: { type: "string" },
              answers: { type: "array", minItems: 1, maxItems: 8, items: { type: "object", additionalProperties: false,
                required: ["questionId", "selectedValues"], properties: { questionId: { type: "string" },
                  selectedValues: { type: "array", minItems: 1, maxItems: 1, items: { type: "string" } } } } },
            },
          } } } },
          responses: { "200": { description: "{ accepted: true, requestId }，仅确认接收，不代表决策完成" },
            "400": { description: "回答不完整、非法选择或携带客户端约束补丁" },
            "409": { description: "运行/会话/追问不匹配、已回答、已结束或过期" } },
        },
      },
      "/api/conversations": {
        get: { summary: "列出可恢复会话", responses: { "200": { description: "会话摘要数组" } } },
        post: {
          summary: "创建可恢复会话",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: {
            id: { type: "string", description: "可选的客户端会话 ID" },
          } } } } },
          responses: { "201": { description: "新会话" }, "400": { description: "会话 ID 无效" } },
        },
      },
      "/api/conversations/{id}": {
        get: {
          summary: "恢复会话、短期记忆与方案版本",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "完整会话" }, "404": { description: "会话不存在" } },
        },
      },
      "/api/conversations/{id}/confirm": {
        post: {
          summary: "确认当前方案中的候选项",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object",
            required: ["version"], properties: { version: { type: "integer", minimum: 1 }, planId: { type: "string" } } } } } },
          responses: { "200": { description: "确认后的会话" }, "409": { description: "方案版本或候选项已失效" } },
        },
      },
      "/api/segments": {
        get: { summary: "列出用户分层", responses: { "200": { description: "分层列表" } } },
      },
      "/api/profiles": {
        get: { summary: "列出画像", responses: { "200": { description: "画像数组" } } },
        post: {
          summary: "创建/更新画像",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/ProfileRequest" } },
            },
          },
          responses: { "200": { description: "已保存画像" } },
        },
      },
      "/api/profiles/{id}": {
        get: {
          summary: "获取画像",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "画像" }, "404": { description: "未找到" } },
        },
        delete: {
          summary: "删除画像",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "删除结果" } },
        },
      },
      "/api/metrics": {
        get: { summary: "运行时指标快照", responses: { "200": { description: "指标" } } },
      },
      "/api/admin/flags": {
        get: { summary: "查看运行时降级开关", responses: { "200": { description: "开关状态" } } },
        post: {
          summary: "设置运行时降级开关",
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/FlagsRequest" } } },
          },
          responses: { "200": { description: "更新后的开关" } },
        },
      },
    },
    components: {
      schemas: {
        DecideRequest: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", description: "自然语言需求，如『周末带老婆孩子下午出去玩』" },
            segment: { type: "string", description: "用户分层（与 profileId 二选一）" },
            profileId: { type: "string", description: "已保存画像 ID" },
            sessionId: { type: "string", description: "可恢复会话 ID；复用后继承当前会话短期记忆" },
            autoSegment: { type: "boolean", description: "无画像时自动分层" },
            weather: { type: "string", enum: ["clear", "rain", "snow", "hot", "cold", "unknown"] },
          },
        },
        ProfileRequest: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            segment: { type: "string" },
            override: { type: "object" },
          },
        },
        FlagsRequest: {
          type: "object",
          properties: {
            rateLimit: { type: "boolean" },
            forceMockIntent: { type: "boolean" },
            cache: { type: "boolean" },
          },
        },
      },
    },
  };
}
