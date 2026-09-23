import type { DecisionScenario } from "./schema.js";
import { createBeijingFixture } from "./fixtures/beijing.js";
import { createShanghaiFixture } from "./fixtures/shanghai.js";

const beijing = (label: string) => createBeijingFixture(label);
const shanghai = (label: string) => createShanghaiFixture(label);

export const DECISION_SCENARIOS: DecisionScenario[] = [
  {
    id: "shanghai_couple_japanese",
    description: "上海目的地在多轮补充中保留，并适配情侣与日料偏好",
    domain: "activity",
    turns: [
      { user: "我这周末想去上海玩，帮我制定一个计划" },
      { user: "我选美食约会" },
      { user: "哦对，我带我女朋友去，她喜欢日料" },
      { user: "预算人均280左右，而且不要太赶" },
    ],
    environment: {
      location: { source: "coords", location: { lat: 31.2304, lng: 121.4737, address: "上海 Decision Fixture 出发点", city: "上海", district: "黄浦区" } },
      data: shanghai("Shanghai Fixture"),
    },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { destinationCity: "上海", leadRole: "partner", budget: "medium", preferredCuisine: ["日料"] },
      hardConstraints: { destinationCity: "上海" },
      preferences: { preferredCuisine: ["日料"], leadRole: "partner" },
      adaptations: [
        { afterTurn: 2, requiredConstraintChanges: { destinationCity: "上海" }, preserved: ["destination"] },
        { afterTurn: 3, requiredConstraintChanges: { leadRole: "partner", preferredCuisine: ["日料"] }, preserved: ["destination"] },
        { afterTurn: 4, requiredConstraintChanges: { budget: "medium" }, preserved: ["destination", "leadRole", "preferredCuisine"] },
      ],
    },
    tags: ["multi_turn", "destination", "preference_update", "couple"],
  },
  {
    id: "elderly_dietary_retention",
    description: "后续补充条件时保留老人、预算和忌口信息",
    domain: "activity",
    turns: [
      { user: "周末带爸妈出去走走，吃得清淡些" },
      { user: "预算省一点，附近就好" },
      { user: "另外不吃海鲜" },
    ],
    environment: { location: { source: "default", location: { ...beijing("Elderly").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Elderly") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "elderly", budget: "low", dietaryRestrictions: ["轻油盐", "免海鲜"] },
      hardConstraints: { maxDistanceKm: 15, dietaryRestrictions: ["免海鲜"] },
      preferences: { preferredMaxKm: 15, dietaryRestrictions: ["轻油盐", "免海鲜"], leadRole: "elderly" },
      adaptations: [
        { afterTurn: 2, requiredConstraintChanges: { leadRole: "elderly", budget: "low" }, preserved: ["leadRole"] },
        { afterTurn: 3, requiredConstraintChanges: { dietaryRestrictions: ["轻油盐", "免海鲜"] }, preserved: ["leadRole", "budget"] },
      ],
    },
    tags: ["multi_turn", "dietary", "distance", "elderly"],
  },
  {
    id: "preference_correction",
    description: "用户纠正菜系后删除旧偏好并保留情侣场景",
    domain: "activity",
    turns: [
      { user: "我和女朋友周末约会，想吃日料" },
      { user: "不想吃日料了，改吃火锅，预算适中" },
    ],
    environment: { location: { source: "default", location: { ...beijing("Correction").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Correction") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "partner", preferredCuisine: ["火锅"], budget: "medium" },
      hardConstraints: {},
      preferences: { leadRole: "partner", preferredCuisine: ["火锅"] },
      adaptations: [{ afterTurn: 2, requiredPreferenceChanges: { preferredCuisine: ["火锅"] }, preserved: ["leadRole"] }],
    },
    tags: ["multi_turn", "preference_correction", "couple"],
  },
  {
    id: "family_kid_dietary",
    description: "家庭带孩子并追加减脂、清淡饮食偏好",
    domain: "activity",
    turns: [
      { user: "周六带5岁孩子和老婆出去玩" },
      { user: "她最近在减肥，吃得清淡一点" },
    ],
    environment: { location: { source: "default", location: { ...beijing("Family").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Family") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "kids", dietaryRestrictions: ["轻油盐"] },
      hardConstraints: { dietaryRestrictions: ["轻油盐"] },
      preferences: { dietaryRestrictions: ["轻油盐"], leadRole: "kids" },
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: { dietaryRestrictions: ["轻油盐"] }, preserved: ["leadRole"] }],
    },
    tags: ["multi_turn", "dietary", "family", "kid"],
  },
  {
    id: "friends_cuisine_update",
    description: "朋友聚会中追加菜系偏好和预算",
    domain: "activity",
    turns: [
      { user: "周末和几个朋友出去玩" },
      { user: "大家想吃粤菜，预算充裕" },
    ],
    environment: { location: { source: "default", location: { ...beijing("Friends").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Friends") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { preferredCuisine: ["粤菜"], budget: "high", leadRole: "friends_group" },
      hardConstraints: {},
      preferences: { preferredCuisine: ["粤菜"], leadRole: "friends_group" },
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: { preferredCuisine: ["粤菜"], budget: "high" }, preserved: ["leadRole"] }],
    },
    tags: ["multi_turn", "preference_update", "friends"],
  },
  {
    id: "solo_nearby",
    description: "独自出行并追加附近的软距离偏好",
    domain: "activity",
    turns: [
      { user: "我周末想一个人放松一下" },
      { user: "附近就好，不想走太远" },
    ],
    environment: { location: { source: "default", location: { ...beijing("Solo").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Solo") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "solo_relax", preferredMaxKm: 15 },
      hardConstraints: {},
      preferences: { leadRole: "solo_relax", preferredMaxKm: 15 },
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: { preferredMaxKm: 15 }, preserved: ["leadRole"] }],
    },
    tags: ["multi_turn", "soft_distance", "solo"],
  },
  {
    id: "hard_distance_limit",
    description: "一公里硬距离上限与 fixture 数据冲突，应该识别无可行方案",
    domain: "activity",
    turns: [
      { user: "周末和朋友出去玩" },
      { user: "所有地点都必须在1公里以内" },
    ],
    environment: { location: { source: "default", location: { ...beijing("HardDistance").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Hard Distance") },
    expectations: {
      expectedFeasibility: "infeasible",
      finalConstraints: { hardMaxKm: 1 },
      hardConstraints: { maxDistanceKm: 1 },
      preferences: {},
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: { hardMaxKm: 1 } }],
    },
    tags: ["multi_turn", "hard_constraint", "distance", "no_feasible_plan"],
  },
  {
    id: "destination_retention_shanghai",
    description: "先确定上海目的地，再追加同行人信息",
    domain: "activity",
    turns: [
      { user: "这周末去上海玩" },
      { user: "和朋友一起，想安排轻松一点" },
    ],
    environment: { location: { source: "coords", location: { lat: 31.2304, lng: 121.4737, address: "上海 Decision Fixture 出发点", city: "上海" } }, data: shanghai("Shanghai Fixture Retention") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { destinationCity: "上海", leadRole: "friends_group" },
      hardConstraints: { destinationCity: "上海" },
      preferences: { leadRole: "friends_group" },
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: { leadRole: "friends_group" }, preserved: ["destination"] }],
    },
    tags: ["multi_turn", "destination", "destination_retention", "friends"],
  },
  {
    id: "irrelevant_information",
    description: "加入当前 Planner 不应改变核心约束的无关信息",
    domain: "activity",
    turns: [
      { user: "周末和朋友在北京逛展" },
      { user: "我最近换了手机" },
    ],
    environment: { location: { source: "default", location: { ...beijing("Irrelevant").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Irrelevant") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { destinationCity: "北京", leadRole: "friends_group" },
      hardConstraints: { destinationCity: "北京" },
      preferences: { leadRole: "friends_group" },
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: {}, preserved: ["destination", "leadRole"] }],
    },
    tags: ["multi_turn", "irrelevant_information", "friends"],
  },
  {
    id: "dietary_restriction_update",
    description: "从清淡偏好追加为不吃海鲜和不吃辣",
    domain: "activity",
    turns: [
      { user: "周末带爸妈吃得清淡些" },
      { user: "另外不吃海鲜，也不吃辣" },
    ],
    environment: { location: { source: "default", location: { ...beijing("Dietary").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Dietary") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "elderly", dietaryRestrictions: ["轻油盐", "免海鲜", "免辣"] },
      hardConstraints: { dietaryRestrictions: ["免海鲜", "免辣"] },
      preferences: { dietaryRestrictions: ["轻油盐", "免海鲜", "免辣"], leadRole: "elderly" },
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: { dietaryRestrictions: ["轻油盐", "免海鲜", "免辣"] }, preserved: ["leadRole"] }],
    },
    tags: ["multi_turn", "dietary", "elderly"],
  },
  {
    id: "soft_distance_relaxation",
    description: "用户先要求附近，随后允许适度扩大范围",
    domain: "activity",
    turns: [
      { user: "周末和女朋友约会，附近就好" },
      { user: "如果附近选择少，远一点也可以" },
    ],
    environment: { location: { source: "default", location: { ...beijing("Relax").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Relax") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "partner", preferredMaxKm: 15 },
      hardConstraints: {},
      preferences: { leadRole: "partner", preferredMaxKm: 15 },
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: { preferredMaxKm: 15 }, preserved: ["leadRole"] }],
    },
    tags: ["multi_turn", "soft_distance", "preference_update", "couple"],
  },
  {
    id: "cuisine_to_dietary",
    description: "先确定菜系，再增加饮食限制",
    domain: "activity",
    turns: [
      { user: "我和女朋友周末想吃火锅" },
      { user: "她最近减肥，想吃清淡一些" },
    ],
    environment: { location: { source: "default", location: { ...beijing("CuisineDiet").destinationCenters!.北京 } }, data: beijing("Beijing Fixture Cuisine Diet") },
    expectations: {
      expectedFeasibility: "feasible",
      finalConstraints: { leadRole: "partner", preferredCuisine: ["火锅"] },
      hardConstraints: {},
      preferences: { leadRole: "partner", preferredCuisine: ["火锅"], dietaryRestrictions: ["轻油盐"] },
      adaptations: [{ afterTurn: 2, requiredConstraintChanges: { dietaryRestrictions: ["轻油盐"] }, preserved: ["leadRole", "preferredCuisine"] }],
    },
    tags: ["multi_turn", "dietary", "preference_update", "couple"],
  },
];

/** Compatibility export for the previous transition harness. */
export const CONVERSATION_CASES = DECISION_SCENARIOS;
