export interface MemoryExpectation {
  destinationCity?: string;
  leadRole?: string;
  budget?: "low" | "medium" | "high";
  preferredCuisine?: string[];
  dietaryRestrictions?: string[];
  extraHints?: string[];
}
export interface ConversationEvalTurn { user: string; expectedMemory: MemoryExpectation }
export interface ConversationEvalCase {
  name: string;
  description: string;
  turns: ConversationEvalTurn[];
  hardConstraints?: { destinationCity?: string; maxDistanceKm?: number; dietaryRestrictions?: string[] };
}

export const CONVERSATION_CASES: ConversationEvalCase[] = [
  {
    name: "shanghai_couple_japanese",
    description: "方向选择后补充同行人与餐饮偏好",
    turns: [
      { user: "我这周末想去上海玩，帮我制定一个计划", expectedMemory: { destinationCity: "上海" } },
      { user: "我选美食约会", expectedMemory: { destinationCity: "上海", extraHints: ["美食", "浪漫"] } },
      { user: "哦对，我带我女朋友去，她喜欢日料", expectedMemory: {
        destinationCity: "上海", leadRole: "partner", preferredCuisine: ["日料"], extraHints: ["美食", "浪漫"] } },
      { user: "预算人均280左右，而且不要太赶", expectedMemory: { destinationCity: "上海", leadRole: "partner",
        budget: "medium", preferredCuisine: ["日料"], extraHints: ["美食", "浪漫", "休闲慢游", "少赶路"] } },
    ],
    hardConstraints: { destinationCity: "上海" },
  },
  {
    name: "elderly_dietary_retention",
    description: "后续补充条件时保留老人和忌口信息",
    turns: [
      { user: "周末带爸妈出去走走，吃得清淡些", expectedMemory: { leadRole: "elderly", dietaryRestrictions: ["轻油盐"] } },
      { user: "预算省一点，附近就好", expectedMemory: { leadRole: "elderly", budget: "low", dietaryRestrictions: ["轻油盐"] } },
      { user: "另外不吃海鲜", expectedMemory: { leadRole: "elderly", budget: "low", dietaryRestrictions: ["轻油盐", "免海鲜"] } },
    ],
    hardConstraints: { maxDistanceKm: 15, dietaryRestrictions: ["免海鲜"] },
  },
  {
    name: "preference_correction",
    description: "用户纠正偏好后删除旧值并保留其他条件",
    turns: [
      { user: "我和女朋友周末约会，想吃日料", expectedMemory: { leadRole: "partner", preferredCuisine: ["日料"] } },
      { user: "不想吃日料了，改吃火锅，预算适中", expectedMemory: { leadRole: "partner", preferredCuisine: ["火锅"], budget: "medium" } },
    ],
  },
];
