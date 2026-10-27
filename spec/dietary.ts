/** Canonical values retained for compatibility with the existing constraint/eval contract. */
export const CANONICAL_DIETARY_REQUIREMENTS = [
  "免海鲜",
  "免辣",
  "轻油盐",
  "素食",
  "低卡",
  "轻食",
  "软食",
] as const;

export type DietaryRequirement = (typeof CANONICAL_DIETARY_REQUIREMENTS)[number];
export type DietaryCompatibilityStatus = "supported" | "unsupported" | "unknown";

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_DIETARY_REQUIREMENTS);

/** Convert supported natural-language aliases or legacy LLM labels to one stable requirement key. */
export function normalizeDietaryRestriction(value: string): DietaryRequirement | undefined {
  const text = value.trim().toLowerCase().replace(/\s+/g, "");
  if (CANONICAL_SET.has(text)) return text as DietaryRequirement;

  if (["seafood_free", "seafoodfree", "no_seafood"].includes(text)
    || (/(海鲜|seafood)/i.test(text) && /(不吃|不能吃|不要|免|避免|忌|过敏|free|no_)/i.test(text))) return "免海鲜";
  if (["non_spicy", "nonspicy", "no_spicy"].includes(text)
    || (/(辣|spicy)/i.test(text) && /(不吃|不能吃|不要|免|避免|忌|non_|no_)/i.test(text))) return "免辣";
  if (["light_oil_salt", "low_oil_salt"].includes(text)
    || text.includes("清淡") || text.includes("少油盐") || text.includes("轻油盐")) return "轻油盐";
  if (["vegetarian", "vegan"].includes(text) || text.includes("素食") || text.includes("吃素")) return "素食";
  if (["low_calorie", "lowcalorie"].includes(text) || text.includes("低卡") || text.includes("低热量")) return "低卡";
  if (["light_food", "lightfood"].includes(text) || text.includes("轻食")) return "轻食";
  if (["soft_food", "softfood"].includes(text) || text.includes("软食") || text.includes("易消化")) return "软食";
  return undefined;
}
