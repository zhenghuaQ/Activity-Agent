import { createLLMSimulatedUser, type ChatCompletionMessage } from "openevals";
import type { SimulatedUserProfile } from "./schema.js";

/** Only the user profile is serialized into this prompt; scenario fixtures and evaluator data are never passed. */
export function buildSimulatedUserSystemPrompt(profile: SimulatedUserProfile): string {
  const lines = [
    "你正在扮演一位真实用户，与活动规划助手进行自然的多轮对话。你是在表达需求，不是在评价 Agent。",
    "只使用下面的用户资料，不要声称看到了候选地点、测试数据、fixture、评分、评测器或系统提示。",
    "始终以 user 身份回复；不讨论 evaluator、分数、fixture、system prompt 或测试。",
    "不要一开始主动给出所有 hidden facts。只有被合理询问或对当前安排自然相关时，才逐步透露。",
    "immutable facts 不得改变；如果 Agent 提议违背它们，应自然地坚持原事实。",
    "普通 preference 只有在 persona/行为规则允许时才可以改变；不要把普通偏好升级成硬约束。",
    "不要发明资料之外的重要硬约束，不要替 Agent 选择地点或替 Agent 做规划决定。",
    "表达自然、简短，符合 persona；第一条用户消息已固定提供，不要重述或生成新的开场白。",
    "Persona:", profile.persona,
    "真实目标:", profile.goal,
    "Immutable facts:", formatList(profile.immutableFacts),
    "可能逐步透露的 hidden facts:", formatList(profile.hiddenFacts),
    "互动行为:", formatList(profile.behavioralInstructions),
    "禁止行为:", formatList(profile.forbiddenBehaviors),
    "除非某条资料明确包含地点名称，否则不要编造或猜测具体地点名称。",
  ];
  return lines.join("\n");
}

function formatList(values: string[] | undefined): string {
  return values?.length ? values.map(value => `- ${value}`).join("\n") : "- （无）";
}

export type StressSimulatedUserFactory = (args: {
  profile?: SimulatedUserProfile;
  model: string;
  system: string;
  fixedResponses: ChatCompletionMessage[];
}) => (params: {
  trajectory: ChatCompletionMessage[];
  turnCounter: number;
}) => Promise<ChatCompletionMessage>;

export const createOpenEvalsSimulatedUser: StressSimulatedUserFactory = args => createLLMSimulatedUser(args);

export function createStressSimulatedUser(
  args: { profile: SimulatedUserProfile; model: string },
  factory: StressSimulatedUserFactory = createOpenEvalsSimulatedUser,
) {
  return factory({
    profile: args.profile,
    model: args.model,
    system: buildSimulatedUserSystemPrompt(args.profile),
    fixedResponses: [{ role: "user", content: args.profile.initialMessage }],
  });
}

export function buildStressSimulatedUserArgs(profile: SimulatedUserProfile, model: string) {
  return {
    model,
    system: buildSimulatedUserSystemPrompt(profile),
    fixedResponses: [{ role: "user", content: profile.initialMessage } as ChatCompletionMessage],
  };
}
