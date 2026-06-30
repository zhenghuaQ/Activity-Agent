// ============================================================
// src/llm/intent.ts — LLM 意图解析（OpenAI 兼容接口）
// 替代 src/intent/parser.ts 中的关键词匹配
// ============================================================

import type {
  StructuredConstraints,
  LeadRole,
  Scenario,
} from "../../spec/types.js";
import { getLLMClient, getLLMConfig } from "./config.js";
import type OpenAI from "openai";
import { HOME } from "../data/mock.js";
import { parseIntent as mockParse } from "../intent/parser.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("llm:intent");

const SCENARIOS: Scenario[] = ["family", "friends", "couple", "solo"];
const LEAD_ROLES: LeadRole[] = [
  "kids",
  "elderly",
  "mixed_family",
  "partner",
  "friends_group",
  "solo_relax",
];

/** 数值夹取，非法回退默认 */
function clampNum(v: number | undefined, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** 营业末点，与 Mock 解析器保持一致 */
const DAY_END_MIN = 21 * 60;

/** StructuredConstraints 的 JSON Schema 描述（用于 function calling） */
const INTENT_SCHEMA = {
  name: "extract_activity_intent",
  description: "从用户自然语言中提取活动规划的结构化约束",
  parameters: {
    type: "object",
    properties: {
      scenario: {
        type: "string",
        enum: ["family", "friends", "couple", "solo"],
        description: "出行场景：family=家庭, friends=朋友聚会, couple=情侣, solo=独自",
      },
      leadRole: {
        type: "string",
        enum: ["kids", "elderly", "mixed_family", "partner", "friends_group", "solo_relax"],
        description: "主导角色：kids=带娃, elderly=陪老人, mixed_family=全家老少, partner=情侣, friends_group=朋友, solo_relax=独自",
      },
      totalPeople: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        description: "总人数",
      },
      hasYoungChild: { type: "boolean", description: "是否有幼年儿童(0-10岁)" },
      youngChildCount: { type: "integer", minimum: 0 },
      hasTeen: { type: "boolean", description: "是否有青少年(10-15岁)" },
      teenCount: { type: "integer", minimum: 0 },
      hasSenior: { type: "boolean", description: "是否有老人(50+)" },
      seniorCount: { type: "integer", minimum: 0 },
      dieting: { type: "boolean", description: "是否有人正在减肥/控制饮食" },
      dietaryRestrictions: {
        type: "array",
        items: { type: "string" },
        description: "忌口偏好，如：轻油盐、免辣、素食、低卡、免海鲜",
      },
      preferredCuisine: {
        type: "array",
        items: { type: "string" },
        description: "偏好的菜系，如：粤菜、日料、火锅",
      },
      budget: {
        type: "string",
        enum: ["low", "medium", "high"],
        description: "预算级别",
      },
      startTime: { type: "string", description: "计划开始时间，格式 HH:MM，如 14:00" },
      durationHours: {
        type: "number",
        minimum: 1,
        maximum: 12,
        description: "活动时长（小时）",
      },
      maxDistanceKm: {
        type: "number",
        minimum: 1,
        maximum: 50,
        description: "最大距离约束（公里）",
      },
      extraHints: {
        type: "array",
        items: { type: "string" },
        description: "额外提示词，如：拍照打卡、浪漫、亲子、展览、小吃、蛋糕、鲜花",
      },
    },
    required: ["scenario", "leadRole", "totalPeople", "startTime", "durationHours"],
  },
};

interface LLMIntentResult {
  scenario: Scenario;
  leadRole: LeadRole;
  totalPeople: number;
  hasYoungChild: boolean;
  youngChildCount: number;
  hasTeen: boolean;
  teenCount: number;
  hasSenior: boolean;
  seniorCount: number;
  dieting: boolean;
  dietaryRestrictions: string[];
  preferredCuisine: string[];
  budget?: "low" | "medium" | "high";
  startTime: string;
  durationHours: number;
  maxDistanceKm: number;
  extraHints: string[];
}

/**
 * 试用 LLM 解析意图，失败时降级为 Mock 关键词匹配。
 */
export async function parseIntentWithLLM(rawText: string): Promise<StructuredConstraints> {
  const client = getLLMClient();
  const config = getLLMConfig();

  if (!client || !config.enabled) {
    log.info("未配置 API Key，使用 Mock 关键词匹配");
    return mockParse(rawText);
  }

  try {
    log.info({ model: config.model }, "调用 LLM 解析意图");
    const resp = await client.chat.completions.create({
      model: config.model,
      messages: [
        {
          role: "system",
          content: `你是AI出行决策助手的意图解析模块。从用户输入中提取结构化约束。
规则：
- 默认下午出发(startTime="14:00")，默认5小时(durationHours=5)
- 默认距离25km，用户说"附近"/"不远"则为15km
- couple 场景默认2人，solo 默认1人，其余默认3人
- "女朋友"/"老婆"/"约会" → scenario=couple, leadRole=partner
- "孩子"/"小孩"+"老婆" → scenario=family（不是couple）, leadRole=kids
- "爸妈"/"父母"/"老人" → 有senior, leadRole=elderly 或 mixed_family
- "减肥"/"轻食"/"低卡" → dieting=true
- "拍照"/"好看" → extraHints: ["拍照打卡"]`,
        },
        { role: "user", content: rawText },
      ],
      tools: [{ type: "function", function: INTENT_SCHEMA }],
      tool_choice: { type: "function", function: { name: "extract_activity_intent" } },
      temperature: 0.1,
      max_tokens: 500,
    });

    const toolCall = resp.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function") {
      log.warn("LLM 未返回 function call，降级 Mock");
      return mockParse(rawText);
    }

    const parsed: LLMIntentResult = JSON.parse(toolCall.function.arguments);

    // 解析增强：校验关键枚举，非法则降级 Mock，避免污染下游决策
    if (!SCENARIOS.includes(parsed.scenario) || !LEAD_ROLES.includes(parsed.leadRole)) {
      log.warn({ scenario: parsed.scenario, leadRole: parsed.leadRole }, "LLM 返回非法枚举，降级 Mock");
      return mockParse(rawText);
    }

    log.info(
      { scenario: parsed.scenario, leadRole: parsed.leadRole, people: parsed.totalPeople },
      "LLM 解析成功"
    );

    return llmResultToConstraints(parsed);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "LLM 解析异常，降级 Mock");
    return mockParse(rawText);
  }
}

/** 将 LLM 返回结果转换为 StructuredConstraints（含夹取与营业时间封顶） */
function llmResultToConstraints(r: LLMIntentResult): StructuredConstraints {
  const totalPeople = clampNum(r.totalPeople, 1, 20, 3);
  const startMin = timeStrToMin(r.startTime || "14:00");
  let durationHours = clampNum(r.durationHours, 1, 12, 5);

  // 末点封顶 21:00，并同步回算时长（与 Mock 解析器一致，避免窗口自相矛盾）
  let endMin = startMin + durationHours * 60;
  if (endMin > DAY_END_MIN) {
    endMin = DAY_END_MIN;
    durationHours = Math.max(1, Math.round(((endMin - startMin) / 60) * 10) / 10);
  }
  const endH = Math.floor(endMin / 60) % 24;
  const endM = endMin % 60;
  const end = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;

  return {
    group: {
      scenario: r.scenario,
      totalPeople,
      maleCount: Math.ceil(totalPeople / 2),
      femaleCount: totalPeople - Math.ceil(totalPeople / 2),
      ageGroup: {
        youngChildren: r.youngChildCount || (r.hasYoungChild ? 1 : 0),
        teens: r.teenCount || (r.hasTeen ? 1 : 0),
        adults: Math.max(
          0,
          totalPeople - (r.youngChildCount || 0) - (r.teenCount || 0) - (r.seniorCount || 0)
        ),
        seniors: r.seniorCount || (r.hasSenior ? 1 : 0),
      },
      leadRole: r.leadRole,
      preferences: {
        dieting: r.dieting || false,
        budget: r.budget,
        dietaryRestrictions: r.dietaryRestrictions || [],
        preferredCuisine: r.preferredCuisine,
        inferredDietary: {
          lightDiet: (r.dietaryRestrictions || []).includes("轻油盐") || !!r.hasSenior || !!r.dieting,
          kidsFriendly: !!r.hasYoungChild,
          lowCalorie: !!r.dieting || (r.dietaryRestrictions || []).includes("低卡"),
          softFood: (r.seniorCount || 0) > 1 || (r.dietaryRestrictions || []).includes("软食"),
          restrictions: r.dietaryRestrictions || [],
        },
      },
    },
    timeWindow: {
      start: r.startTime || "14:00",
      end,
      durationHours,
    },
    distance: {
      maxKm: clampNum(r.maxDistanceKm, 1, 50, 25),
      homeLocation: { ...HOME },
    },
    extraHints: r.extraHints || [],
  };
}

function timeStrToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}