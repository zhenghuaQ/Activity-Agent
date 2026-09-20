// ============================================================
// spec/tools.ts — Tool 输入输出签名（SDD 契约）
// 仅保留「决策相关」工具：定位 / 搜索 / 可用性查询 / 追问 / 通勤估算。
// 不含任何下单、预订、取号、配送下单等交易/履约动作。
// ============================================================

import type {
  Attraction,
  BreakPlace,
  BreakSubtype,
  CrowdTag,
  DistanceConstraint,
  FollowUpQuestion,
  GeoLocation,
  Group,
  LocalFeatureTag,
  Restaurant,
  TimeWindow,
} from "./types.js";
import type { DestinationQuery, SearchArea } from "./datasource.js";

// ─── Tool: resolve_destination ─────────────────────────

export interface ResolveDestinationInput { destination: DestinationQuery }
export type ResolveDestinationOutput = SearchArea;

// ─── Tool 0: get_user_location ─────────────────────────
// 🆕 获取用户真实定位（Mock → 真实API）

export interface GetUserLocationInput {
  /** 用户ID或设备标识（Demo可忽略） */
  userId?: string;
}

export type GetUserLocationOutput = GeoLocation;

// ─── Tool 1: search_attractions ─────────────────────────
// 🔄 增加 localFeatures 参数

export interface SearchAttractionsInput {
  crowdTags: CrowdTag[];
  timeWindow: TimeWindow;
  distance: DistanceConstraint;
  destination?: DestinationQuery;
  searchArea?: SearchArea;
  keywords?: string[];
  /** 🆕 当地特色标签 */
  localFeatures?: LocalFeatureTag[];
}

export type SearchAttractionsOutput = Attraction[];

// ─── Tool 2: search_restaurants ─────────────────────────
// 🔄 增加 dietaryRestrictions, localFeatures

export interface SearchRestaurantsInput {
  group: Group;
  timeWindow: TimeWindow;
  distance: DistanceConstraint;
  destination?: DestinationQuery;
  searchArea?: SearchArea;
  preferenceTags?: string[];
  /** 偏好菜系用于排序；没有匹配项时不清空候选。 */
  preferredCuisine?: string[];
  /** 🆕 忌口关键词 */
  dietaryRestrictions?: string[];
  /** 🆕 当地特色标签 */
  localFeatures?: LocalFeatureTag[];
}

export type SearchRestaurantsOutput = Restaurant[];

// ─── Tool 3: search_break_places ────────────────────────
// 🆕 搜索茶歇地点（茶馆/咖啡厅/儿童小乐园）

export interface SearchBreakPlacesInput {
  /** 茶歇子类型偏好 */
  breakSubtype: BreakSubtype;
  /** 是否有老年人（需要无障碍设施） */
  hasElderly: boolean;
  /** 是否有幼年儿童 */
  hasYoungChildren: boolean;
  distance: DistanceConstraint;
  destination?: DestinationQuery;
  searchArea?: SearchArea;
  /** 期望的时间段 */
  afterTime: string;
}

export type SearchBreakPlacesOutput = BreakPlace[];

// ─── Tool 4: check_attraction_availability ───────────────

export interface CheckAttractionAvailabilityInput {
  attractionId: string;
  arrivalTime: string;
}

export interface AttractionAvailability {
  attractionId: string;
  available: boolean;
  remainingTickets?: number;
  estimatedQueueMinutes: number;
}

export type CheckAttractionAvailabilityOutput = AttractionAvailability;

// ─── Tool 5: check_restaurant_availability ───────────────

export interface CheckRestaurantAvailabilityInput {
  restaurantId: string;
  diningTime: string;
  partySize: number;
}

export interface RestaurantAvailability {
  restaurantId: string;
  available: boolean;
  hasTable: boolean;
  queueCount: number;
  estimatedWaitMinutes: number;
}

export type CheckRestaurantAvailabilityOutput = RestaurantAvailability;

// ─── Tool 6: generate_followup_questions ────────────────
// 🆕 根据解析结果生成追问

export interface GenerateFollowUpInput {
  constraints: import("./types.js").StructuredConstraints;
}

export type GenerateFollowUpOutput = FollowUpQuestion[];

// ─── Tool: estimate_transit ─────────────────────────────

export interface EstimateTransitInput {
  from: GeoLocation;
  to: GeoLocation;
  departureTime: string;
}

export type EstimateTransitOutput = import("./transit.js").TransitEstimate;
// ─── Agent 顶层输入 ─────────────────────────────────────

export interface AgentInput {
  rawText: string;
  group: Group;
  timeWindow: TimeWindow;
  distance: DistanceConstraint;
}

// ─── LLM 工具定义（Claude Code 式：工具定义即给模型的接口）──
//
// Agentic Loop 的前提：每个工具携带 description + JSON Schema，
// 让模型理解「何时调用、如何传参」。与上方 TS 输入类型一一对应。

/** JSON Schema 值（LLM 工具参数的最小结构描述） */
export interface JsonSchemaObject {
  type: "object";
  description?: string;
  properties: Record<string, JsonSchemaValue>;
  required?: string[];
}

export type JsonSchemaValue =
  | JsonSchemaObject
  | { type: "string"; description?: string; enum?: string[] }
  | { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: JsonSchemaValue };

/** 一个工具的 LLM 接口定义 */
export interface LLMToolDefinition {
  description: string;
  inputSchema: JsonSchemaObject;
}

/** OpenAI 兼容的 function tool 格式（chat.completions 的 tools 参数） */
export interface LLMToolFormat {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
  };
}

// ─── 复用片段 ──────────────────────────────────────────

const CROWD_TAG_ENUM = [
  "family_kids",
  "family_elderly",
  "family_mixed",
  "friends",
  "couple",
  "solo",
  "kids",
  "teens",
  "seniors",
] as const;

const LOCAL_FEATURE_ENUM = [
  "local_cuisine",
  "historical_site",
  "local_craft",
  "scenic_spot",
  "night_market",
  "local_tea",
  "popular_checkin",
] as const;

const timeWindowSchema: JsonSchemaObject = {
  type: "object",
  description: "出行时间窗口",
  properties: {
    start: { type: "string", description: "开始时间 HH:MM，如 14:00" },
    end: { type: "string", description: "结束时间 HH:MM" },
    durationHours: { type: "number", description: "时长（小时）" },
  },
  required: ["start", "end"],
};

const distanceSchema: JsonSchemaObject = {
  type: "object",
  description: "距离约束（出发点 + 最大搜索半径）",
  properties: {
    maxKm: { type: "number", description: "最大搜索半径（公里），候选不足时可扩大" },
    homeLocation: {
      type: "object",
      description: "出发点经纬度",
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        address: { type: "string" },
        city: { type: "string" },
        district: { type: "string" },
      },
      required: ["lat", "lng"],
    },
  },
  required: ["maxKm", "homeLocation"],
};

const destinationSchema: JsonSchemaObject = {
  type: "object",
  description: "用户明确指定的旅行目的地",
  properties: {
    city: { type: "string" },
    district: { type: "string" },
  },
  required: ["city"],
};

const searchAreaSchema: JsonSchemaObject = {
  type: "object",
  description: "Provider 已解析的实际检索区域",
  properties: {
    destination: destinationSchema,
    center: {
      type: "object", properties: { lat: { type: "number" }, lng: { type: "number" },
        address: { type: "string" }, city: { type: "string" }, district: { type: "string" } },
      required: ["lat", "lng", "address", "city"],
    },
    providerAreaId: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["destination", "center", "confidence"],
};

const groupSchema: JsonSchemaObject = {
  type: "object",
  description: "出行人群信息（意图解析产出，通常直接透传）",
  properties: {
    scenario: { type: "string", enum: ["family", "friends", "couple", "solo"], description: "出行场景" },
    totalPeople: { type: "integer", minimum: 1, maximum: 20 },
    leadRole: {
      type: "string",
      enum: ["kids", "elderly", "mixed_family", "partner", "friends_group", "solo_relax"],
      description: "主导角色",
    },
    ageGroup: {
      type: "object",
      description: "年龄分组人数",
      properties: {
        youngChildren: { type: "integer", description: "0-10岁" },
        teens: { type: "integer", description: "10-15岁" },
        adults: { type: "integer", description: "16-50岁" },
        seniors: { type: "integer", description: "50岁以上" },
      },
    },
    preferences: {
      type: "object",
      description: "偏好",
      properties: {
        dieting: { type: "boolean", description: "是否有人减肥" },
        budget: { type: "string", enum: ["low", "medium", "high"] },
        dietaryRestrictions: { type: "array", items: { type: "string" }, description: "忌口" },
        preferredCuisine: { type: "array", items: { type: "string" }, description: "偏好菜系" },
      },
    },
  },
  required: ["scenario", "leadRole", "totalPeople"],
};

const constraintsSchema: JsonSchemaObject = {
  type: "object",
  description: "结构化出行约束（意图解析的产物）",
  properties: {
    destination: destinationSchema,
    group: groupSchema,
    timeWindow: timeWindowSchema,
    distance: distanceSchema,
    extraHints: { type: "array", items: { type: "string" }, description: "额外提示词" },
  },
  required: ["group", "timeWindow", "distance"],
};

export const RESOLVE_DESTINATION_TOOL: LLMToolDefinition = {
  description: "将城市/行政区目的地解析为 Provider 可检索的中心点。无法覆盖该城市时必须明确失败，不能换成其他城市。",
  inputSchema: { type: "object", properties: { destination: destinationSchema }, required: ["destination"] },
};

// ─── Tool 的 LLM 接口定义 ───────────────────────────────

export const GET_USER_LOCATION_TOOL: LLMToolDefinition = {
  description:
    "获取用户当前出发位置（经纬度+地址）。规划开始时先调用，后续搜索以返回的坐标为中心。",
  inputSchema: {
    type: "object",
    properties: {
      userId: { type: "string", description: "用户ID（可选，Demo 可忽略）" },
    },
  },
};

export const SEARCH_ATTRACTIONS_TOOL: LLMToolDefinition = {
  description:
    "搜索附近景点/玩乐地点。按人群标签、距离半径过滤，返回含评分、室内外、建议游玩时长与可用时段的列表。候选不足时应扩大 maxKm 重搜，仍不足可放宽 crowdTags。",
  inputSchema: {
    type: "object",
    properties: {
      crowdTags: {
        type: "array",
        description: "适合人群标签（至少一个），如带娃传 family_kids",
        items: { type: "string", enum: [...CROWD_TAG_ENUM] },
      },
      timeWindow: timeWindowSchema,
      distance: distanceSchema,
      destination: destinationSchema,
      searchArea: searchAreaSchema,
      keywords: { type: "array", items: { type: "string" }, description: "关键词（可选）" },
      localFeatures: {
        type: "array",
        description: "当地特色标签（可选）",
        items: { type: "string", enum: [...LOCAL_FEATURE_ENUM] },
      },
    },
    required: ["crowdTags", "timeWindow", "distance"],
  },
};

export const SEARCH_RESTAURANTS_TOOL: LLMToolDefinition = {
  description:
    "搜索附近餐厅。支持忌口、偏好标签与人群匹配（有老人优先老年餐、有幼童优先儿童友好）。返回含菜系、人均、排队数的列表。",
  inputSchema: {
    type: "object",
    properties: {
      group: groupSchema,
      timeWindow: timeWindowSchema,
      distance: distanceSchema,
      destination: destinationSchema,
      searchArea: searchAreaSchema,
      preferenceTags: {
        type: "array",
        items: { type: "string" },
        description: "偏好标签（如 轻食、儿童友好）",
      },
      preferredCuisine: {
        type: "array",
        items: { type: "string" },
        description: "偏好菜系，用于优先排序而非硬过滤",
      },
      dietaryRestrictions: {
        type: "array",
        items: { type: "string" },
        description: "忌口（如 免辣、免海鲜）",
      },
      localFeatures: {
        type: "array",
        items: { type: "string", enum: [...LOCAL_FEATURE_ENUM] },
      },
    },
    required: ["group", "timeWindow", "distance"],
  },
};

export const SEARCH_BREAK_PLACES_TOOL: LLMToolDefinition = {
  description:
    "搜索茶歇地点（茶馆/咖啡厅/甜品店/室内儿童乐园）。支持无障碍与儿童友好过滤，返回含建议停留时长与距离的列表。",
  inputSchema: {
    type: "object",
    properties: {
      breakSubtype: {
        type: "string",
        enum: ["tea_house", "cafe", "dessert_shop", "kids_indoor_play"],
        description: "茶歇子类型",
      },
      hasElderly: { type: "boolean", description: "是否有老人（过滤无障碍设施）" },
      hasYoungChildren: { type: "boolean", description: "是否有幼童（过滤儿童友好）" },
      distance: distanceSchema,
      destination: destinationSchema,
      searchArea: searchAreaSchema,
      afterTime: { type: "string", description: "期望到达时间 HH:MM" },
    },
    required: ["breakSubtype", "hasElderly", "hasYoungChildren", "distance", "afterTime"],
  },
};

export const CHECK_ATTRACTION_AVAILABILITY_TOOL: LLMToolDefinition = {
  description:
    "查询景点在指定到达时间的可用性：是否有余票/名额、预计排队分钟数。仅查询用于可行性校验，不做任何预订。",
  inputSchema: {
    type: "object",
    properties: {
      attractionId: { type: "string", description: "景点ID（来自搜索结果的 id 字段）" },
      arrivalTime: { type: "string", description: "到达时间 HH:MM" },
    },
    required: ["attractionId", "arrivalTime"],
  },
};

export const CHECK_RESTAURANT_AVAILABILITY_TOOL: LLMToolDefinition = {
  description:
    "查询餐厅在指定用餐时间是否有位、排队人数与预计等待分钟数（>30 分钟视为不可行）。仅查询，不取号不预订。",
  inputSchema: {
    type: "object",
    properties: {
      restaurantId: { type: "string", description: "餐厅ID（来自搜索结果的 id 字段）" },
      diningTime: { type: "string", description: "用餐时间 HH:MM" },
      partySize: { type: "integer", minimum: 1, description: "用餐人数" },
    },
    required: ["restaurantId", "diningTime", "partySize"],
  },
};

export const GENERATE_FOLLOWUP_TOOL: LLMToolDefinition = {
  description:
    "根据已解析的出行约束生成追问问题（如孩子年龄、老人忌口、预算），用于确认关键信息。仅对需要追问的角色（kids/elderly 等）调用。",
  inputSchema: {
    type: "object",
    properties: {
      constraints: constraintsSchema,
    },
    required: ["constraints"],
  },
};

export const ESTIMATE_TRANSIT_TOOL: LLMToolDefinition = {
  description:
    "估算两点间的通勤耗时（分钟）。用于判断地点间距是否合理、编排时间线。有真实地图数据时走路径规划，否则用 Mock 估算。",
  inputSchema: {
    type: "object",
    properties: {
      from: {
        type: "object",
        description: "起点经纬度",
        properties: {
          lat: { type: "number" },
          lng: { type: "number" },
        },
        required: ["lat", "lng"],
      },
      to: {
        type: "object",
        description: "终点经纬度",
        properties: {
          lat: { type: "number" },
          lng: { type: "number" },
        },
        required: ["lat", "lng"],
      },
      departureTime: { type: "string", description: "出发时间 HH:MM" },
    },
    required: ["from", "to", "departureTime"],
  },
};

/** 全部工具的 LLM 定义索引（key 为工具名） */
export const TOOL_DEFS: Record<string, LLMToolDefinition> = {
  resolve_destination: RESOLVE_DESTINATION_TOOL,
  get_user_location: GET_USER_LOCATION_TOOL,
  search_attractions: SEARCH_ATTRACTIONS_TOOL,
  search_restaurants: SEARCH_RESTAURANTS_TOOL,
  search_break_places: SEARCH_BREAK_PLACES_TOOL,
  check_attraction_availability: CHECK_ATTRACTION_AVAILABILITY_TOOL,
  check_restaurant_availability: CHECK_RESTAURANT_AVAILABILITY_TOOL,
  generate_followup_questions: GENERATE_FOLLOWUP_TOOL,
  estimate_transit: ESTIMATE_TRANSIT_TOOL,
};


