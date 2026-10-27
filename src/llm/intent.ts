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
import { parseIntent as mockParse } from "../intent/parser.js";
import { childLogger } from "../core/logger.js";
import { throwIfAborted } from "../runtime/abort.js";
import { CANONICAL_DIETARY_REQUIREMENTS, normalizeDietaryRestriction } from "../../spec/dietary.js";

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
      destinationCity: { type: "string", description: "旅行目的地城市；用户未说明则为空字符串" },
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
        items: { type: "string", enum: [...CANONICAL_DIETARY_REQUIREMENTS] },
        description: "只输出规范忌口标识：免海鲜、免辣、轻油盐、素食、低卡、轻食、软食；将用户同义表达映射到这些标识",
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
      hardMaxDistanceKm: {
        type: "number",
        minimum: 1,
        maximum: 50,
        description: "仅当用户明确表达不可超过时填写的硬距离上限（公里）",
      },
      hardMaxDurationMinutes: {
        type: "number",
        minimum: 1,
        maximum: 720,
        description: "仅当用户明确说只有/最多/不超过某时长时填写的总行程硬上限（分钟）；默认时长、约/左右等模糊目标不填写",
      },
      preferredMaxDistanceKm: {
        type: "number",
        minimum: 1,
        maximum: 50,
        description: "用户偏好的距离范围（公里），不是不可违反的硬约束",
      },
      extraHints: {
        type: "array",
        items: { type: "string" },
        description: "额外提示词，如：拍照打卡、浪漫、亲子、展览、小吃、蛋糕、鲜花",
      },
      planSpecification: {
        type: "object",
        description: "仅当用户明确要求具体景点/地点数量或明确表达用餐结构时填写；不可从轻松、丰富等偏好推断。",
        properties: {
          activityCount: { type: "integer", minimum: 1, maximum: 20, description: "用户明确要求的景点/游玩地点精确数量；未明确则省略" },
          mealPolicy: { type: "string", enum: ["required", "optional", "none"], description: "仅按明确表达：要吃饭=required，可吃可不吃=optional，不安排饭/餐厅=none；未提及省略" },
        },
        additionalProperties: false,
      },
    },
    required: ["scenario", "leadRole", "totalPeople", "startTime", "durationHours"],
  },
};

interface LLMIntentResult {
  destinationCity?: string;
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
  hardMaxDurationMinutes?: number;
  hardMaxDistanceKm?: number;
  preferredMaxDistanceKm?: number;
  extraHints: string[];
  planSpecification?: { activityCount?: number; mealPolicy?: "required" | "optional" | "none" };
}

/**
 * 试用 LLM 解析意图，失败时降级为 Mock 关键词匹配。
 */
export async function parseIntentWithLLM(
  rawText: string,
  signal?: AbortSignal,
): Promise<StructuredConstraints> {
  throwIfAborted(signal);
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
- 仅在用户明确表达“只有/最多/不超过N小时”等硬上限时填写 hardMaxDurationMinutes；“N小时左右/大约N小时”及默认时长不得填写
- 没有距离需求时不要填写 hardMaxDistanceKm 或 preferredMaxDistanceKm
- hardMaxDistanceKm 只用于“5公里以内/不超过5公里/最多5公里”等明确硬上限
- preferredMaxDistanceKm 用于“最好5公里左右/尽量近/附近”等软偏好
- 用户明确说去某个城市时写入 destinationCity；未说明目的地时留空，不要把当前位置当作目的地
- couple 场景默认2人，solo 默认1人，其余默认3人
- "女朋友"/"老婆"/"约会" → scenario=couple, leadRole=partner
- "孩子"/"小孩"+"老婆" → scenario=family（不是couple）, leadRole=kids
- "爸妈"/"父母"/"老人" → 有senior, leadRole=elderly 或 mixed_family
- "减肥"/"轻食"/"低卡" → dieting=true
- 将具体忌口按语义映射为规范标识：不能吃/不要海鲜→免海鲜，不能吃辣/不要辣→免辣；不要把菜系偏好当成忌口
- "拍照"/"好看" → extraHints: ["拍照打卡"]
- planSpecification 只记录用户明确提出的结构：明确数量如“两个景点”填写 activityCount=2；明确“不吃饭/不需要餐厅”填 mealPolicy=none；“吃不吃都行”填 optional；“安排吃饭”填 required。未明确时省略，不得从“轻松/丰富/不要太赶”等推断。`,
        },
        { role: "user", content: rawText },
      ],
      tools: [{ type: "function", function: INTENT_SCHEMA }],
      tool_choice: { type: "function", function: { name: "extract_activity_intent" } },
      temperature: 0.1,
      max_tokens: 500,
    }, signal ? { signal } : undefined);

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

    const constraints = llmResultToConstraints(parsed);
    // Keep explicit structure extraction deterministic and contract-identical to the local parser.
    const explicitStructure = mockParse(rawText).planSpecification;
    if (explicitStructure) constraints.planSpecification = explicitStructure;
    else delete constraints.planSpecification;
    return constraints;
  } catch (err) {
    throwIfAborted(signal);
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
  const dietaryRestrictions = [...new Set(r.dietaryRestrictions.map(value => {
    const normalized = normalizeDietaryRestriction(value);
    if (!normalized) throw new Error("unsupported_dietary_requirement");
    return normalized;
  }))];

  return {
    ...(r.destinationCity?.trim() ? { destination: { city: r.destinationCity.trim() } } : {}),
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
        dietaryRestrictions,
        preferredCuisine: r.preferredCuisine,
        inferredDietary: {
          lightDiet: dietaryRestrictions.includes("轻油盐") || !!r.hasSenior || !!r.dieting,
          kidsFriendly: !!r.hasYoungChild,
          lowCalorie: !!r.dieting || dietaryRestrictions.includes("低卡"),
          softFood: (r.seniorCount || 0) > 1 || dietaryRestrictions.includes("软食"),
          restrictions: dietaryRestrictions,
        },
      },
    },
    timeWindow: {
      start: r.startTime || "14:00",
      end,
      durationHours,
    },
    distance: {
      ...(r.hardMaxDistanceKm !== undefined ? { hardMaxKm: clampNum(r.hardMaxDistanceKm, 1, 50, 25) } : {}),
      ...(r.preferredMaxDistanceKm !== undefined ? { preferredMaxKm: clampNum(r.preferredMaxDistanceKm, 1, 50, 25) } : {}),
    },
    ...(isValidPlanSpecification(r.planSpecification) ? { planSpecification: { ...r.planSpecification } } : {}),
    ...(r.hardMaxDurationMinutes !== undefined
      ? { hardMaxDurationMinutes: Math.round(clampNum(r.hardMaxDurationMinutes, 1, 720, 1)) }
      : {}),
    extraHints: r.extraHints || [],
  };
}

function isValidPlanSpecification(value: LLMIntentResult["planSpecification"]): value is NonNullable<LLMIntentResult["planSpecification"]> {
  if (!value || typeof value !== "object") return false;
  const activityCount = value.activityCount;
  const mealPolicy = value.mealPolicy;
  return (activityCount === undefined || (Number.isInteger(activityCount) && activityCount >= 1 && activityCount <= 20))
    && (mealPolicy === undefined || mealPolicy === "required" || mealPolicy === "optional" || mealPolicy === "none");
}

function timeStrToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
