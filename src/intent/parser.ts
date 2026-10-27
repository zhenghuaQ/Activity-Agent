// ============================================================
// src/intent/parser.ts — 意图解析（Mock LLM）
// 从自然语言提取 StructuredConstraints
// 后续替换为真实 LLM API 调用即可
// ============================================================

import type {
  AgeGroup,
  DietaryInference,
  DistanceConstraint,
  Group,
  LeadRole,
  Scenario,
  StructuredConstraints,
  TimeWindow,
  UserPreferences,
  PlanSpecification,
} from "../../spec/types.js";
import { extractDestination, extractPreferredCuisine } from "../conversation/memory.js";
import { normalizeDietaryRestriction, type DietaryRequirement } from "../../spec/dietary.js";

/**
 * Mock LLM 意图解析。
 * 用关键词匹配模拟 LLM 的抽取能力。
 * 生产环境：替换为 prompt → structured output（JSON Schema）
 */
export function parseIntent(rawText: string): StructuredConstraints {
  const lower = rawText.toLowerCase();

  // ─── 场景识别 ────────────────────────────────
  let scenario: Scenario = "family";
  const hasCoupleKeyword = lower.includes("女朋友") || lower.includes("老婆") || lower.includes("老公") || lower.includes("对象") || lower.includes("男友") || lower.includes("约会");
  const hasFamilyKeyword = lower.includes("孩子") || lower.includes("小孩") || lower.includes("儿子") || lower.includes("女儿") || lower.includes("全家");
  // 情侣关键词+无家庭关键词 → couple；否则走后续判断
  if (hasCoupleKeyword && !hasFamilyKeyword) {
    scenario = "couple";
  } else if (lower.includes("朋友") || lower.includes("哥们") || lower.includes("闺蜜")) {
    scenario = "friends";
  } else if (lower.includes("独自") || lower.includes("一个人") || lower.includes("自己")) {
    scenario = "solo";
  }

  // ─── 主导角色识别 ─────────────────────────────
  let leadRole: LeadRole = "friends_group";
  const hasChild = (lower.includes("孩子") || lower.includes("小孩") || lower.includes("儿子") || lower.includes("女儿") || /\d+岁/.test(lower))
    && !/(不带|不用带|不和|不跟)(孩子|小孩|儿子|女儿)/.test(lower);
  const hasElderly = (lower.includes("老人") || lower.includes("爸妈") || lower.includes("父母") || lower.includes("爷爷奶奶"))
    && !/(不带|不用带|不和|不跟)(爸妈|父母|老人|爷爷奶奶)/.test(lower);

  if (hasChild && hasElderly) {
    leadRole = "mixed_family";
  } else if (hasChild) {
    leadRole = "kids";
  } else if (hasElderly) {
    leadRole = "elderly";
  } else if (scenario === "couple") {
    leadRole = "partner";
  } else if (scenario === "solo") {
    leadRole = "solo_relax";
  }

  // ─── 人数识别 ────────────────────────────────
  const totalPeople = extractPeopleCount(lower, scenario);

  // ─── 年龄分组 ────────────────────────────────
  const ageGroup = extractAgeGroup(lower, totalPeople);

  // ─── 用户偏好 ────────────────────────────────
  const dieting = lower.includes("减肥") || lower.includes("瘦身") || lower.includes("轻食") || lower.includes("低卡");
  const dietaryRestrictions = extractDietaryRestrictions(lower);

  // 推断餐饮需求
  const inferredDietary: DietaryInference = {
    lightDiet: dietaryRestrictions.includes("轻油盐") || ageGroup.seniors > 0 || dieting,
    kidsFriendly: ageGroup.youngChildren > 0,
    lowCalorie: dieting || dietaryRestrictions.includes("低卡"),
    softFood: ageGroup.seniors > 1 || dietaryRestrictions.includes("软食"),
    restrictions: dietaryRestrictions,
  };

  const preferences: UserPreferences = {
    dieting,
    budget: lower.includes("预算充裕") || lower.includes("贵一点") || /人均\s*(?:[4-9]\d{2}|[1-9]\d{3,})/.test(lower) ? "high"
      : lower.includes("预算适中") || lower.includes("人均100-200") || /人均\s*(?:1\d{2}|2\d{2}|3\d{2})/.test(lower) ? "medium"
        : lower.includes("省钱") || /省(?:一)?(?:点|些)/.test(lower) || lower.includes("便宜") || lower.includes("人均100以内") || /人均\s*\d{1,2}(?:\D|$)/.test(lower) ? "low" : undefined,
    dietaryRestrictions,
    preferredCuisine: extractPreferredCuisine(lower),
    inferredDietary,
  };

  // ─── 人群 ──────────────────────────────────

  const maleCount = Math.ceil(totalPeople / 2);
  const femaleCount = totalPeople - maleCount;

  const group: Group = {
    scenario,
    totalPeople,
    maleCount,
    femaleCount,
    ageGroup,
    leadRole,
    preferences,
  };

  // ─── 时间窗口 ────────────────────────────────
  const timeWindow = extractTimeWindow(lower);

  // ─── 距离约束 ─────────────────────────────────
  const distance = extractDistanceConstraint(lower);

  // ─── 额外提示 ────────────────────────────────
  const extraHints: string[] = [];
  if (lower.includes("亲子")) extraHints.push("亲子乐园");
  if (lower.includes("展览")) extraHints.push("展览");
  if (lower.includes("小吃")) extraHints.push("小吃街");
  if (lower.includes("蛋糕")) extraHints.push("蛋糕");
  if (lower.includes("鲜花") || lower.includes("花")) extraHints.push("鲜花");
  if (lower.includes("拍照")) extraHints.push("拍照打卡");
  if (lower.includes("浪漫")) extraHints.push("浪漫");
  if (lower.includes("美食约会")) extraHints.push("美食", "浪漫");
  if (lower.includes("经典城市") || lower.includes("城市地标")) extraHints.push("城市地标", "历史文化");
  if (lower.includes("休闲慢游") || lower.includes("不要太赶") || lower.includes("少赶路")) extraHints.push("休闲慢游", "少赶路");

  const hardMaxDurationMinutes = extractHardMaxDurationMinutes(lower);
  const planSpecification = extractPlanSpecification(lower);
  return {
    destination: extractDestination(lower), group, timeWindow, distance, extraHints,
    ...(Object.keys(planSpecification).length ? { planSpecification } : {}),
    ...(hardMaxDurationMinutes !== undefined ? { hardMaxDurationMinutes } : {}),
  };
}

function extractPlanSpecification(text: string): PlanSpecification {
  const specification: PlanSpecification = {};
  if (/(不吃饭|不用安排吃饭|不需要餐厅|不安排餐厅|不需要用餐)/.test(text)) {
    specification.mealPolicy = "none";
  } else if (/(吃饭可有可无|吃不吃都行|饭可吃可不吃|用餐可有可无)/.test(text)) {
    specification.mealPolicy = "optional";
  } else if (/(安排吃饭|要吃饭|安排用餐|安排一顿饭|安排一餐|还是吃饭|还是安排吃饭)/.test(text)) {
    specification.mealPolicy = "required";
  }

  const countMatch = text.match(/(?:逛|去|玩|安排)?\s*(\d+|一个|一处|两处|两个|二个|三处|三个|四处|四个|五处|五个)\s*(?:个)?\s*(景点|地方|地点|处|(?:简单)?活动)/)
    ?? text.match(/(\d+|一个|一处|两处|两个|二个|三处|三个|四处|四个|五处|五个)\s*(景点|地方|地点|处|(?:简单)?活动)/);
  if (countMatch && !/(多逛几个|尽量多玩|丰富一点|多玩几个)/.test(text)) {
    const numeric = Number(countMatch[1]);
    const chinese: Record<string, number> = { "一个": 1, "一处": 1, "两处": 2, "两个": 2, "二个": 2, "三处": 3, "三个": 3, "四处": 4, "四个": 4, "五处": 5, "五个": 5 };
    const value = Number.isInteger(numeric) && numeric > 0 ? numeric : chinese[countMatch[1]!];
    if (value !== undefined && value <= 20) specification.activityCount = value;
  }
  return specification;
}

function extractHardMaxDurationMinutes(text: string): number | undefined {
  if (/(左右|大概|差不多|约|大约|上下)/.test(text)) return undefined;
  const match = text.match(/(最多|只有|僅有|仅有|不超过|不能超过|不得超过|限时|限定|时间.{0,3}放宽到)\s*(\d+(?:\.\d+)?)\s*(小时|个小时|钟头)/);
  return match ? Math.round(Number(match[2]) * 60) : undefined;
}

// ─── 辅助函数 ──────────────────────────────────────

function extractPeopleCount(text: string, scenario: Scenario): number {
  const match = text.match(/(\d+)\s*个?\s*人/);
  if (match) return parseInt(match[1], 10);

  if (text.includes("全家") || text.includes("一家")) return 3;
  if (text.includes("两个人") || text.includes("两人")) return 2;

  // 场景感知默认值
  if (scenario === "couple") return 2;
  if (scenario === "solo") return 1;
  return 3; // family/friends 默认 3 人
}

function extractAgeGroup(text: string, total: number): AgeGroup {
  const ageGroup: AgeGroup = { youngChildren: 0, teens: 0, adults: total, seniors: 0 };

  const ageMatch = text.match(/(\d+)\s*岁/);
  const childAge = ageMatch ? parseInt(ageMatch[1], 10) : 0;

  if (childAge > 0) {
    if (childAge <= 10) {
      ageGroup.youngChildren = 1;
      ageGroup.adults = total - 1;
    } else if (childAge <= 15) {
      ageGroup.teens = 1;
      ageGroup.adults = total - 1;
    }
  }

  // 老人
  if (text.includes("老人") || text.includes("爸妈") || text.includes("父母")) {
    const elderCount = text.includes("爸妈") || text.includes("父母") ? 2 : 1;
    ageGroup.seniors = elderCount;
    ageGroup.adults = Math.max(0, ageGroup.adults - elderCount);
  }

  return ageGroup;
}

function extractDietaryRestrictions(text: string): DietaryRequirement[] {
  const phrases = [
    "不能吃海鲜", "不吃海鲜", "不要海鲜", "免海鲜", "seafood_free",
    "不能吃辣", "不吃辣", "不要辣", "忌辣", "免辣", "non_spicy",
    "轻油盐", "少油盐", "清淡", "素食", "吃素",
    "低卡", "低热量", "轻食", "软食", "易消化",
  ];
  return [...new Set(phrases
    .filter(phrase => text.includes(phrase))
    .map(phrase => normalizeDietaryRestriction(phrase))
    .filter((requirement): requirement is DietaryRequirement => requirement !== undefined))];
}

function extractTimeWindow(text: string): TimeWindow {
  // 默认下午 14:00 开始，5小时
  let start = "14:00";
  let durationHours = 5;

  // 识别"上午"/"下午"/"晚上"
  const isMorning = text.includes("上午") || text.includes("早上") || text.includes("上午");
  const isEvening = text.includes("晚上");
  const isAfternoon = text.includes("下午") || (!isMorning && !isEvening);

  // 时长解析：优先识别区间（4-6小时），否则识别单值（4个小时 / 4小时 / 4钟头）
  const rangeMatch = text.match(/(\d+)\s*[-~到至]\s*(\d+)\s*(小时|个?钟|个?小时)/);
  if (rangeMatch) {
    const low = parseInt(rangeMatch[1], 10);
    const high = parseInt(rangeMatch[2], 10);
    durationHours = Math.round((low + high) / 2);
  } else {
    const singleMatch = text.match(/(\d+)\s*个?\s*(小时|钟头|个钟)/);
    if (singleMatch) durationHours = parseInt(singleMatch[1], 10);
  }

  // 提取具体出发时间
  const timeMatch = text.match(/(\d{1,2})[点:：](\d{2})?/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    // 如果是下午/晚上且小时<12，+12
    let actualHour = h;
    if ((isAfternoon || isEvening) && h < 12) {
      actualHour = h + 12;
    }
    start = `${String(actualHour).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  } else {
    // 根据时间段设置默认开始时间
    if (isMorning) start = "09:00";
    else if (isEvening) start = "18:00";
    else start = "14:00"; // 下午默认
  }

  // 计算结束时间
  const startMin = parseInt(start.split(":")[0], 10) * 60 + parseInt(start.split(":")[1], 10);
  let endMin = startMin + durationHours * 60;

  // 修正：不超过 21:00；并同步收敛 durationHours，避免 end 与 durationHours 不一致
  const CAP_MIN = 21 * 60;
  if (endMin > CAP_MIN) endMin = CAP_MIN;
  const adjustedDuration = Math.round(((endMin - startMin) / 60) * 10) / 10;

  const endH = Math.floor(endMin / 60) % 24;
  const endM = endMin % 60;
  const end = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;

  return { start, end, durationHours: adjustedDuration };
}

function extractDistanceConstraint(text: string): DistanceConstraint {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?|[一二两三四五六七八九十百]+)\s*(?:公里|千米|km)/gi)]
    .map((match) => ({ value: parseDistanceNumber(match[1]), index: match.index ?? 0 }));
  const nearby = text.includes("不远") || text.includes("附近") || text.includes("就近") || text.includes("近一点");
  if (matches.length > 0 && matches.every((match) => Number.isFinite(match.value))) {
    const hard = /(以内|不超过|最多|最远|不要超过|不能超过)/.test(text);
    const soft = /(左右|最好|尽量|附近|不远|就近|近一点)/.test(text);
    if (hard && soft && matches.length >= 2) {
      const hardCue = [...text.matchAll(/以内|不超过|最多|最远|不要超过|不能超过/g)]
        .map((match) => match.index ?? 0);
      const softCue = [...text.matchAll(/左右|最好|尽量|附近|不远|就近|近一点/g)]
        .map((match) => match.index ?? 0);
      const nearest = (cue: number[]) => matches.reduce((best, candidate) => {
        const bestDistance = Math.min(...cue.map((index) => Math.abs(index - best.index)));
        const candidateDistance = Math.min(...cue.map((index) => Math.abs(index - candidate.index)));
        return candidateDistance < bestDistance ? candidate : best;
      });
      const hardMatch = nearest(hardCue);
      const softMatch = nearest(softCue);
      if (hardMatch.index !== softMatch.index) {
        return { hardMaxKm: hardMatch.value, preferredMaxKm: softMatch.value };
      }
    }
    if (hard || !soft) return { hardMaxKm: matches[0].value };
    return { preferredMaxKm: matches[0].value };
  }
  return nearby ? { preferredMaxKm: 15 } : {};
}

function parseDistanceNumber(value: string): number {
  if (/^\d/.test(value)) return Number(value);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === "十") return 10;
  if (value.endsWith("十")) return (digits[value[0]] ?? 1) * 10;
  if (value.startsWith("十")) return 10 + (digits[value[1]] ?? 0);
  return Number(value.split("").reduce((sum, char) => sum * 10 + (digits[char] ?? 0), 0));
}
