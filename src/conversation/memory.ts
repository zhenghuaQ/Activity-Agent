import type { StructuredConstraints } from "../../spec/types.js";

const TIME_WORDS = /(今天|明天|后天|周末|星期|周[一二三四五六日天]|上午|早上|中午|下午|晚上|\d{1,2}[点:：]|小时|钟头)/;
const GROUP_WORDS = /(孩子|小孩|儿子|女儿|爸妈|父母|老人|爷爷|奶奶|女朋友|男朋友|老婆|老公|对象|朋友|闺蜜|哥们|独自|一个人|自己|\d+\s*个?\s*人)/;
const DIET_WORDS = /(减肥|瘦身|轻食|低卡|放纵|控卡)/;
const RESTRICTION_WORDS = /(清淡|轻油盐|辣|海鲜|素食|吃素|软食|忌口|过敏)/;
const DISTANCE_WORDS = /(附近|不远|就近|距离|公里|km)/i;
const BUDGET_WORDS = /(预算|人均|省钱|便宜|性价比|充裕|贵一点)/;
const CUISINES = ["日料", "日本料理", "粤菜", "云南菜", "火锅", "川菜", "西餐", "韩餐", "烧烤", "素食"];
const CITIES = ["北京", "上海", "广州", "深圳", "杭州", "成都", "重庆", "南京", "苏州", "西安", "武汉", "长沙", "厦门", "青岛", "天津"];

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }

export function extractDestination(text: string): StructuredConstraints["destination"] {
  const city = CITIES.find(value => text.includes(value));
  return city ? { city } : undefined;
}

export function extractPreferredCuisine(text: string): string[] {
  return unique(CUISINES.filter(value => text.includes(value)).map(value => value === "日本料理" ? "日料" : value));
}

/** 仅让本轮明确提到的字段覆盖旧值；未提及字段继续保留。 */
export function mergeTurnConstraints(previous: StructuredConstraints | undefined, parsed: StructuredConstraints,
  rawText: string): StructuredConstraints {
  if (!previous) return parsed;
  const text = rawText.trim().toLowerCase();
  const explicitCuisine = extractPreferredCuisine(text);
  const removeCuisine = CUISINES.filter(value => new RegExp(`(不要|不想吃|不喜欢)${value}`).test(text));
  const preferredCuisine = unique([...(previous.group.preferences.preferredCuisine ?? [])
    .filter(value => !removeCuisine.includes(value)), ...explicitCuisine.filter(value => !removeCuisine.includes(value))]);
  const restrictions = RESTRICTION_WORDS.test(text)
    ? unique([...previous.group.preferences.dietaryRestrictions, ...parsed.group.preferences.dietaryRestrictions])
    : [...previous.group.preferences.dietaryRestrictions];
  if (/(可以吃辣|不忌辣)/.test(text)) {
    const index = restrictions.indexOf("免辣"); if (index >= 0) restrictions.splice(index, 1);
  }
  if (/(可以吃海鲜|不忌海鲜)/.test(text)) {
    const index = restrictions.indexOf("免海鲜"); if (index >= 0) restrictions.splice(index, 1);
  }
  const groupExplicit = GROUP_WORDS.test(text);
  const dietingExplicit = DIET_WORDS.test(text);
  const group = groupExplicit ? { ...parsed.group } : { ...previous.group,
    preferences: { ...previous.group.preferences } };
  group.preferences = { ...group.preferences,
    dieting: dietingExplicit ? parsed.group.preferences.dieting : previous.group.preferences.dieting,
    budget: BUDGET_WORDS.test(text) ? parsed.group.preferences.budget : previous.group.preferences.budget,
    dietaryRestrictions: restrictions, preferredCuisine,
    inferredDietary: { ...group.preferences.inferredDietary,
      lightDiet: restrictions.includes("轻油盐") || (dietingExplicit ? parsed.group.preferences.dieting : previous.group.preferences.dieting),
      lowCalorie: restrictions.includes("低卡") || (dietingExplicit ? parsed.group.preferences.dieting : previous.group.preferences.dieting),
      softFood: restrictions.includes("软食"), restrictions: [...restrictions] } };
  const negatedHints = previous.extraHints.filter(hint =>
    !new RegExp(`(不要|取消|不想要|换掉).{0,3}${hint}`).test(text));
  return { destination: extractDestination(text) ?? previous.destination ?? parsed.destination, group,
    timeWindow: TIME_WORDS.test(text) ? parsed.timeWindow : previous.timeWindow,
    distance: DISTANCE_WORDS.test(text) ? parsed.distance : previous.distance,
    extraHints: unique([...negatedHints, ...parsed.extraHints]) };
}
