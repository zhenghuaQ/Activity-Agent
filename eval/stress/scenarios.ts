import { createBeijingFixture } from "../decision/scenarios/fixtures/beijing.js";
import { createShanghaiFixture } from "../decision/scenarios/fixtures/shanghai.js";
import type { StressScenario } from "./schema.js";

const beijing = (name: string) => createBeijingFixture(`Stress ${name}`);
const shanghai = (name: string) => createShanghaiFixture(`Stress ${name}`);
const beijingEnvironment = (name: string) => {
  const data = beijing(name);
  return { location: { source: "default" as const, location: { ...data.destinationCenters!.北京 } }, data };
};
const shanghaiEnvironment = (name: string) => ({
  location: { source: "coords" as const, location: { lat: 31.2304, lng: 121.4737, address: "Stress synthetic start", city: "上海", district: "黄浦区" } },
  data: shanghai(name),
});

/** Stress profiles are separate from DecisionScenario expectations and evaluator references. */
export const STRESS_SCENARIOS: StressScenario[] = [
  {
    id: "underspecified_family_outing",
    description: "少量初始信息下，通过自然澄清逐步了解同行人和活动偏好",
    domain: "activity",
    environment: beijingEnvironment("Underspecified"),
    user: {
      initialMessage: "周末想出去走走，帮我想个轻松的安排。",
      persona: "信息给得不完整，回答自然但不会一开始讲全。",
      goal: "找到适合带父母、步行量轻、吃得清淡的周末活动安排。",
      hiddenFacts: ["同行人是父母", "其中一位老人不能走太久", "希望吃得清淡", "预算中等"],
      behavioralInstructions: ["如果 Agent 问清同行人或活动节奏，再逐条透露相关事实。", "不必每轮都补充新要求。"],
      forbiddenBehaviors: ["不要主动一次性说出所有 hidden facts。", "不要编造具体地点名称。"],
    },
    maxTurns: 5,
    tags: ["underspecified", "clarification", "family"],
  },
  {
    id: "preference_drift_couple",
    description: "在自然对话中途改变普通偏好，但保持约会目标",
    domain: "activity",
    environment: beijingEnvironment("Preference Drift"),
    user: {
      initialMessage: "周末和女朋友约会，想吃日料。",
      persona: "容易临时改变普通偏好，表达随意。",
      goal: "完成轻松的情侣约会安排；聊到吃饭时把日料改成火锅，预算适中。",
      immutableFacts: ["约会同行人是女朋友"],
      hiddenFacts: ["预算人均约200元"],
      behavioralInstructions: ["当 Agent 提到餐饮或预算时，可以改口并给出新偏好。"],
      forbiddenBehaviors: ["不要把软偏好说成不可突破的硬约束。", "不要改变同行人。"],
    },
    maxTurns: 4,
    tags: ["preference_drift", "couple"],
  },
  {
    id: "correction_of_companion",
    description: "用户纠正先前说错的同行人信息",
    domain: "activity",
    environment: beijingEnvironment("Correction"),
    user: {
      initialMessage: "周末想和同事在北京聚一下，最好轻松点。",
      persona: "说话偶尔会先讲错，再及时纠正。",
      goal: "安排一次轻松的老同学聚会；明确纠正同行人是老同学而非同事。",
      hiddenFacts: ["其实是大学同学聚会", "其中有人喜欢粤菜"],
      behavioralInstructions: ["在后续对话中明确纠正‘同事’为‘老同学’。", "菜系只有在被问到时再提。"],
      forbiddenBehaviors: ["不要编造人数或预算。", "纠正后不要反复改回同事。"],
    },
    maxTurns: 4,
    tags: ["contradiction", "correction", "friends"],
  },
  {
    id: "irrelevant_chat_injection",
    description: "用户在需求对话中插入无关信息",
    domain: "activity",
    environment: beijingEnvironment("Irrelevant"),
    user: {
      initialMessage: "周末我想和朋友在北京逛逛，别安排太满。",
      persona: "聊天时会突然提到一些无关的生活琐事。",
      goal: "获得朋友同行、节奏轻松的周末安排。",
      hiddenFacts: ["喜欢展览", "希望行程中有休息时间"],
      behavioralInstructions: ["对需求相关问题正常回答。", "中途可以提一句最近换了手机或天气很热，但不要持续跑题。"],
      forbiddenBehaviors: ["不要把无关聊天变成新的硬约束。", "不要给出 fixture 中的具体场馆名称。"],
    },
    maxTurns: 4,
    tags: ["irrelevant_information", "context_retention"],
  },
  {
    id: "reluctant_short_answers",
    description: "用户不愿长篇回答澄清问题",
    domain: "activity",
    environment: beijingEnvironment("Reluctant"),
    user: {
      initialMessage: "想约会，别太累。",
      persona: "回答简短，有点犹豫，不喜欢被连续盘问。",
      goal: "完成舒适轻松的情侣约会安排。",
      hiddenFacts: ["同行人是女朋友", "喜欢咖啡", "预算普通"],
      behavioralInstructions: ["优先用简短答复。", "每次最多补充一个事实；如果 Agent 连续问太多，可以说‘你先按一般情况安排吧’。"],
      forbiddenBehaviors: ["不要为了配合 Agent 一次性列出全部资料。", "不要主动提供具体地点答案。"],
    },
    maxTurns: 4,
    tags: ["reluctant_user", "short_answers", "clarification"],
  },
  {
    id: "immutable_shanghai_distance",
    description: "软偏好可改变，但目的地和硬距离限制必须保留",
    domain: "activity",
    environment: shanghaiEnvironment("Immutable Distance"),
    user: {
      initialMessage: "去上海玩，所有地点最多只能离出发点5公里。",
      persona: "愿意临时改变菜系和节奏偏好，但对距离限制很坚持。",
      goal: "安排上海活动，可在后续讨论中调整餐饮或节奏。",
      immutableFacts: ["destination=上海", "hard max distance=5km"],
      hiddenFacts: ["同行人是朋友", "更喜欢粤菜"],
      behavioralInstructions: ["目的地始终是上海，硬距离上限始终是5公里。", "如果询问同行人或餐饮，再透露对应偏好。"],
      forbiddenBehaviors: ["不能把上海改成其他城市。", "不能放宽5公里硬限制。"],
    },
    maxTurns: 5,
    tags: ["hard_constraint", "immutable_fact", "destination"],
    invariants: [
      { field: "destination.city", value: "上海" },
      { field: "distance.hardMaxKm", value: 5 },
    ],
  },
  {
    id: "no_feasible_one_km",
    description: "用户坚持 fixture 无法满足的一公里硬距离限制",
    domain: "activity",
    environment: beijingEnvironment("No Feasible"),
    user: {
      initialMessage: "周末和朋友在北京玩，任何地点都必须在出发点1公里以内。",
      persona: "对距离要求很明确，其他偏好可以灵活。",
      goal: "看看严格距离要求下是否存在可行活动。",
      immutableFacts: ["destination=北京", "hard max distance=1km"],
      behavioralInstructions: ["如果被问到，可说明距离要求不可放宽。", "其他信息不确定时可以说都行。"],
      forbiddenBehaviors: ["不要为了让 Agent 找到方案而改变距离上限。", "不要指定 fixture 地点。"],
    },
    maxTurns: 4,
    tags: ["no_feasible", "hard_constraint", "distance"],
    invariants: [
      { field: "destination.city", value: "北京" },
      { field: "distance.hardMaxKm", value: 1 },
    ],
  },
  {
    id: "compound_preference_change",
    description: "用户一轮内同时追加同行人、饮食和预算信息",
    domain: "activity",
    environment: beijingEnvironment("Compound"),
    user: {
      initialMessage: "周末想安排一个轻松点的活动。",
      persona: "想到更多细节时会一次补充好几件事。",
      goal: "安排带父母的轻松活动；补充清淡饮食和人均预算约200元。",
      hiddenFacts: ["同行人是父母", "其中一位老人不吃辣", "预算人均200元", "中间需要休息"],
      behavioralInstructions: ["Agent 问到同行人或偏好时，可以一次说出多个相关事实。", "如果没有被问到，也可以自然补充这些关键需求。"],
      forbiddenBehaviors: ["不要改变同行人或虚构硬距离限制。", "不要提及测试或数据。"],
    },
    maxTurns: 5,
    tags: ["compound_change", "family", "dietary"],
  },
];

export const stressScenarios = STRESS_SCENARIOS;
