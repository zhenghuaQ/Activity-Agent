// ============================================================
// spec/types.ts — 核心数据类型定义（SDD 契约）
// v2: 细化用户画像、茶歇环节、询问机制、当地特色
// ============================================================

import type { TransitEstimate } from "./transit.js";

// ─── 场景与主导角色 ────────────────────────────────────────

/** 出行场景类型 */
export type Scenario = "family" | "friends" | "couple" | "solo";

/** 主导角色：为谁规划？从自然语言推断，必要时追问确认 */
export type LeadRole = 
  | "kids"           // 带孩子玩
  | "elderly"        // 带老人出游
  | "mixed_family"   // 家庭混合（老人+孩子）
  | "partner"        // 带伴侣/女朋友
  | "friends_group"  // 朋友多人出行
  | "solo_relax";    // 独自放松

/** LeadRole 对应的规划策略 */
export const LeadRoleStrategy: Record<LeadRole, {
  label: string;
  description: string;
  /** 偏好的茶歇类型 */
  breakPreference: "tea_house" | "kids_play" | "cafe_dessert" | "none";
  /** 是否需要追问 */
  needsFollowUp: boolean;
}> = {
  kids:          { label: "带娃出行",       description: "以孩子体验为中心",              breakPreference: "kids_play",    needsFollowUp: true },
  elderly:       { label: "陪老人出游",      description: "轻松舒适，注重休息和清淡饮食",       breakPreference: "tea_house",    needsFollowUp: true },
  mixed_family:  { label: "全家老少",       description: "兼顾老人体力和孩子兴趣",             breakPreference: "tea_house",    needsFollowUp: true },
  partner:       { label: "二人世界",       description: "浪漫、拍照打卡、精致餐饮",            breakPreference: "cafe_dessert", needsFollowUp: true },
  friends_group: { label: "朋友聚会",       description: "互动性强、众口协调",                breakPreference: "cafe_dessert", needsFollowUp: true },
  solo_relax:    { label: "独自放松",       description: "安静、有品质的个人时光",              breakPreference: "cafe_dessert", needsFollowUp: false },
};

// ─── 年龄分层 ──────────────────────────────────────────

/** 年龄分组计数 */
export interface AgeGroup {
  /** 幼年：0-10岁 */
  youngChildren: number;
  /** 少年：10-15岁 */
  teens: number;
  /** 成人：16-50岁 */
  adults: number;
  /** 老年：50岁以上 */
  seniors: number;
}

/** 根据年龄自动推断的餐饮需求 */
export interface DietaryInference {
  /** 是否需要清淡少油盐（老年人/减肥者） */
  lightDiet: boolean;
  /** 是否需要儿童友好餐（幼年人数>0） */
  kidsFriendly: boolean;
  /** 是否需要低卡健康餐（减肥） */
  lowCalorie: boolean;
  /** 是否需要软食/易消化（老年人） */
  softFood: boolean;
  /** 原始填写的忌口关键词 */
  restrictions: string[];
}

// ─── 用户偏好（升级版） ─────────────────────────────────

/** 用户偏好 */
export interface UserPreferences {
  /** 是否有人正在减肥 */
  dieting: boolean;
  /** 预算级别 */
  budget?: "low" | "medium" | "high";
  /** 忌口/口味偏好（如：轻油盐、免辣、不吃海鲜） */
  dietaryRestrictions: string[];
  /** 偏好的菜系（如：粤菜、日料） */
  preferredCuisine?: string[];
  /** 自动推断的餐饮需求 */
  inferredDietary: DietaryInference;
}

/** 用户群体信息 */
export interface Group {
  scenario: Scenario;
  totalPeople: number;
  /** 男/女人数 */
  maleCount: number;
  femaleCount: number;
  /** 年龄分组 */
  ageGroup: AgeGroup;
  /** 主导角色 */
  leadRole: LeadRole;
  preferences: UserPreferences;
}

// ─── 询问轮次 ──────────────────────────────────────────

/** 一次询问 */
export interface FollowUpQuestion {
  id: string;
  /** 问题标题（简短） */
  question: string;
  /** 询问原因 */
  reason: string;
  /** 选项（2-3个），首选项为推荐 */
  options: FollowUpOption[];
  /** 问题类型 */
  type: "single_choice" | "multi_choice" | "text_input";
}

export interface FollowUpOption {
  label: string;
  value: string;
  /** 为什么推荐/不推荐 */
  hint: string;
}

/** 询问回答结果，用于更新约束 */
export interface FollowUpAnswer {
  questionId: string;
  selectedValues: string[];
  /** 对约束的修正 */
  patches: Partial<{
    dieting: boolean;
    leadRole: LeadRole;
    dietaryRestrictions: string[];
    preferredCuisine: string[];
    budget: "low" | "medium" | "high";
    extraHints: string[];
  }>;
}

// ─── 约束 ──────────────────────────────────────────────

/** 时间窗口 */
export interface TimeWindow {
  start: string;        // "14:00"
  end: string;          // "20:00"
  durationHours: number; // 4-6
}

/** 距离约束 */
export interface DistanceConstraint {
  /** 用户明确表达的不可突破距离上限。 */
  hardMaxKm?: number;
  /** 用户偏好距离，可在候选不足时放宽。 */
  preferredMaxKm?: number;
}

/** 地理位置 */
export interface GeoLocation {
  lat: number;
  lng: number;
  /** 可读地址 */
  address: string;
  city: string;
  district?: string;
}

/**
 * 结构化约束（从自然语言提取 + 询问修正）。
 * Invariant: StructuredConstraints 只描述用户需求，不承载当前环境事实。
 */
export interface StructuredConstraints {
  /** 旅行目的地；未提供时沿用出发位置所在城市。 */
  destination?: { city: string; district?: string };
  group: Group;
  timeWindow: TimeWindow;
  distance: DistanceConstraint;
  extraHints: string[];
}

// ─── 活动类型（含茶歇） ─────────────────────────────────

/** 活动类型 */
export type ActivityType =
  | "attraction"   // 景点/乐园/展览
  | "break"        // 茶歇：茶馆/咖啡厅/儿童小乐园
  | "restaurant"   // 正餐餐厅
  | "delivery"     // 配送（蛋糕/鲜花）
  | "walking";     // citywalk/小吃街

/** 茶歇子类型 */
export type BreakSubtype = "tea_house" | "cafe" | "dessert_shop" | "kids_indoor_play";

// ─── 适合人群 / 特色标签 ───────────────────────────────

/** 适合人群标签 */
export type CrowdTag = 
  | "family_kids" | "family_elderly" | "family_mixed"
  | "friends" | "couple" | "solo"
  | "kids" | "teens" | "seniors";

/** 当地特色标签 */
export type LocalFeatureTag = 
  | "local_cuisine"         // 当地正宗美食
  | "historical_site"       // 历史古迹
  | "local_craft"           // 当地手工艺/非遗
  | "scenic_spot"           // 特色景观
  | "night_market"          // 夜市小吃
  | "local_tea"             // 当地茶馆
  | "popular_checkin";      // 网红打卡地

// ─── 地点数据结构 ──────────────────────────────────────

/** 地点基础信息 */
export interface Place {
  id: string;
  name: string;
  type: ActivityType;
  crowdTags: CrowdTag[];
  localFeatures: LocalFeatureTag[];
  address: string;
  /** 距离出发点距离（km），通过经纬度计算 */
  distanceKm: number;
  /** 经纬度 */
  location: GeoLocation;
  rating: number;           // 1-5
  pricePerPerson?: number;  // 人均价格
  imageUrl?: string;
  /** 外部地点数据的可追溯来源。 */
  source?: import("./datasource.js").ProviderSource;
}

/** 景点/玩乐地点 */
export interface Attraction extends Place {
  type: "attraction";
  durationMinutes: number;     // 建议游玩时长
  minAge?: number;             // 适合最低年龄
  maxAge?: number;
  indoor: boolean;             // 是否室内（应对天气）
  availableSlots: TimeSlot[];  // 可预约时段
}

/** 茶歇地点（茶馆/咖啡厅/儿童小乐园） */
export interface BreakPlace extends Place {
  type: "break";
  breakSubtype: BreakSubtype;
  durationMinutes: number;      // 建议停留30-60min
  /** 是否有无障碍设施（老年人友好） */
  accessible: boolean;
  /** 是否适合儿童活动 */
  kidsFriendly: boolean;
}

/** 餐厅 */
export interface Restaurant extends Place {
  type: "restaurant";
  cuisine: string;             // 菜系
  tags: string[];              // ["轻食","儿童友好","包间","少油盐","老年餐"]
  avgDurationMinutes: number;  // 平均用餐时长
  hasQueue: boolean;           // 是否需要排队
  queueCount: number;          // 当前排队人数
  /** 是否支持老年/忌口定制 */
  dietaryOptions: boolean;
}

/** 配送商品 */
export interface DeliveryItem extends Place {
  type: "delivery";
  deliverableTo: "restaurant" | "attraction" | "break";
  prepTimeMinutes: number;    // 制作/准备时间
}

// ─── 时间段 ────────────────────────────────────────────

/** 可用时段 */
export interface TimeSlot {
  start: string;     // "14:00"
  end: string;       // "15:30"
  remaining: number; // 剩余名额/座位
}

// ─── 方案 ──────────────────────────────────────────────

/** 方案中的一个活动环节 */
export interface Activity {
  /** 在方案中的顺序 */
  order: number;
  place: Place;
  scheduledStart: string;     // "14:00"
  scheduledEnd: string;       // "16:00"
  /** 决策态：仅用于规划编排，不涉及任何下单/预订动作 */
  status: "pending" | "scheduled";
  /** 前往此环节的通勤预估（首环节为 null） */
  transitTo?: TransitEstimate | null;
  /** 🆕 M2 该环节到达时段的拥挤度预测（可选） */
  crowd?: import("./datasource.js").CrowdPrediction;
}

/** 完整出行方案 */
export interface Plan {
  id: string;
  scenario: Scenario;
  leadRole: LeadRole;
  activities: Activity[];
  totalDurationHours: number;
  totalCost?: number;
  /** 通勤总耗时（分钟） */
  totalTransitMinutes: number;
  /** 方案可行性得分 0-100（硬约束门槛，M2 后作为前置过滤） */
  feasibilityScore: number;
  /** 方案一句话摘要 */
  summary: string;
  /** 🆕 M2 多维评分（可选，决策引擎产出） */
  score?: import("./decision.js").PlanScore;
  /** 🆕 M2 可解释（亮点/取舍/为何不选其它） */
  explanation?: import("./decision.js").PlanExplanation;
}

/** 方案候选（Stage 2 产出） */
export interface PlanCandidate {
  plan: Plan;
  feasibilityScore: number;
  reason: string; // 推荐/不推荐理由
  /** 🆕 M2 该候选最优化的决策目标（帕累托标签） */
  objective?: import("./decision.js").PlanObjective;
}

// ─── Trace（可观测性） ─────────────────────────────────
//
// 已迁移：工具调用统计统一由 spec/tool-response.ts 的
// ToolResponse（stats + context）承载，原 ToolTrace/ToolResult 已移除。

/** 规划阶段（终点为「决策输出」，不含下单确认） */
export type PlanningStage =
  | "intent_parsing"
  | "follow_up_questions"
  | "candidate_generation"
  | "feasibility_check"
  | "fine_scheduling";

/** Stable business conclusion produced only after planning and replanning finish. */
export type PlanningTerminationReason = "plan_selected" | "no_feasible_plan";

/** Machine-readable detail for a normal planning conclusion. */
export type PlanningTerminationCode =
  | "PLAN_SELECTED"
  | "NO_CANDIDATES"
  | "NO_SELECTABLE_PLAN";

export interface PlanningTermination {
  reason: PlanningTerminationReason;
  code: PlanningTerminationCode;
}

/** 规划过程中的中间状态 */
export interface PlanningState {
  stage: PlanningStage;
  /** Written once by ActivityPlanner after the final replan opportunity. Absent on runtime failure. */
  termination?: PlanningTermination;
  constraints?: StructuredConstraints;
  /** Runtime may expand discovery without changing the user's acceptance constraint. */
  searchPolicy?: {
    radiusKm: number;
    /** Runtime safety ceiling; independent from user constraints. */
    maxRadiusKm?: number;
  };
  /** 目的地经 Provider 解析后的实际检索区域。 */
  resolvedSearchArea?: import("./datasource.js").SearchArea;
  /** Incremented whenever derived planning artifacts are invalidated. */
  planRevision?: number;
  followUpQuestions?: FollowUpQuestion[];
  candidates?: PlanCandidate[];
  selectedPlan?: Plan;
  /** 🆕 M2 决策结果：帕累托多方案 + 置信度 + 兜底说明 */
  decision?: import("./decision.js").DecisionResult;
  /** 🆕 M2 规划过程注记（如扩半径兜底），非错误 */
  planningNotes?: string[];
  errors: string[];
}

