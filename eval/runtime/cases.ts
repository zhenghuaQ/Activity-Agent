// ============================================================
// eval/runtime/cases.ts — Runtime Regression 场景用例
// ============================================================

/** 一个测试用例 */
export interface EvalCase {
  name: string;
  description: string;
  rawText: string;
  /** 期望通过的约束检查 */
  expectedChecks: string[];
  /** 最低可行性分数阈值 */
  minScore: number;
}

/** 场景 1: 家庭场景 - 带5岁娃 + 减肥老婆 */
export const case_family: EvalCase = {
  name: "family_kids_dieting",
  description: "周六下午，小明带5岁孩子和减肥的老婆出去玩",
  rawText: "今天下午是空的，想和老婆孩子出去玩4-6个小时，孩子5岁，老婆最近在减肥，别离家太远，帮我安排下",
  expectedChecks: [
    "has_attraction",
    "has_restaurant",
    "has_break_for_elderly", // no, family_kids 不需要这个
    "within_distance",
    "age_dietary_fit",
  ],
  minScore: 50,
};

/** 场景 2: 朋友场景 - 4人 2男2女 */
export const case_friends: EvalCase = {
  name: "friends_group",
  description: "4个朋友（2男2女）下午出去玩",
  rawText: "今天下午想和朋友出去玩4-6个小时，总共4个人，2个男生2个女生，别离家太远，帮安排",
  expectedChecks: [
    "has_attraction",
    "has_restaurant",
  ],
  minScore: 50,
};

/** 场景 3: 带老人场景 */
export const case_elderly: EvalCase = {
  name: "family_elderly",
  description: "带两位老人出去走走，近一点轻松一点",
  rawText: "下午想带爸妈出去转转，4-6小时，别走太远，他们年纪大了需要休息，吃得清淡点",
  expectedChecks: [
    "has_attraction",
    "has_restaurant",
    "has_break_for_elderly",
    "age_dietary_fit",
  ],
  minScore: 50,
};

/** 场景 4: 情侣场景 */
export const case_couple: EvalCase = {
  name: "couple_date",
  description: "和女朋友约会，浪漫一点",
  rawText: "下午想和女朋友出去约会，4-5小时，去好看的地方拍照然后吃顿好的",
  expectedChecks: [
    "has_attraction",
    "has_restaurant",
  ],
  minScore: 60,
};

/** 全部用例 */
export const ALL_CASES: EvalCase[] = [
  case_family,
  case_friends,
  case_elderly,
  case_couple,
];
