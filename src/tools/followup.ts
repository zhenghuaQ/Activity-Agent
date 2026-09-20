// ============================================================
// src/tools/followup.ts — Tool 6: generate_followup_questions
// 可执行问题目录 + LLM 文案润色（失败时保留模板）
// ============================================================

import type { FollowUpQuestion, LeadRole, StructuredConstraints } from "../../spec/types.js";
import { LeadRoleStrategy } from "../../spec/types.js";
import type * as T from "../../spec/tools.js";
import { GENERATE_FOLLOWUP_TOOL } from "../../spec/tools.js";
import { BaseTool, type ToolExecutionContext } from "./base.js";
import { generateFollowUpWithLLM } from "../llm/followup.js";
import { BUDGET_TARGET } from "../decision/constants.js";

export class GenerateFollowUpTool extends BaseTool<
  T.GenerateFollowUpInput,
  T.GenerateFollowUpOutput
> {
  name = "generate_followup_questions";
  description = GENERATE_FOLLOWUP_TOOL.description;
  inputSchema = GENERATE_FOLLOWUP_TOOL.inputSchema;

  async run(input: T.GenerateFollowUpInput, context?: ToolExecutionContext): Promise<FollowUpQuestion[]> {
    const { group } = input.constraints;
    const strategy = LeadRoleStrategy[group.leadRole];

    if (!strategy.needsFollowUp) return [];

    // 只展示已有确定约束映射的问题。LLM 仅润色问题，不决定字段、选项或补丁。
    const catalog = this.questionCatalog(group.leadRole, input.constraints);
    if (!catalog.length) return [];
    const llmResult = await generateFollowUpWithLLM(input.constraints, context?.signal, catalog);
    return catalog.map(q => {
      const wording = llmResult.find(item => item.id === q.id);
      return wording && typeof wording.question === "string" && wording.question.trim() && wording.question.length <= 200
        ? { ...q, question: wording.question } : q;
    });
  }

  private questionCatalog(leadRole: LeadRole, constraints: StructuredConstraints): FollowUpQuestion[] {
    const group = constraints.group;
    const questions: FollowUpQuestion[] = [];

    if (!constraints.extraHints.length && !group.preferences.preferredCuisine?.length) {
      questions.push({
        id: "trip_style",
        question: "这次更想要哪种旅行节奏？",
        reason: "先选一个方向，后续仍可随时补充或修改",
        options: [
          { label: "经典城市游", value: "city_classic", hint: "地标与历史文化" },
          { label: "美食约会", value: "food_date", hint: "美食与氛围体验" },
          { label: "休闲慢游", value: "slow_travel", hint: "少赶路、留出自由时间" },
        ],
        type: "single_choice",
      });
    }

    if (leadRole === "elderly" || leadRole === "mixed_family") {
      questions.push({
        id: "elderly_dietary",
        question: "老人有什么饮食忌口吗？",
        reason: "老年人通常需要少油盐、软食，想确认一下",
        options: [
          { label: "少油少盐即可", value: "light", hint: "筛选支持饮食定制的餐厅，少油盐需向商家确认" },
          { label: "需要软食/易消化", value: "soft", hint: "记录软食需求并筛选支持定制的餐厅，具体菜品需确认" },
          { label: "无额外要求", value: "none", hint: "不增加限制，保留你已说明的忌口" },
        ],
        type: "single_choice",
      });
    }

    if (group.preferences.dieting) {
      questions.push({
        id: "dieting_level",
        question: "减肥到什么程度？帮你筛合适的餐厅",
        reason: "不同阶段对饮食要求不同",
        options: [
          { label: "轻食低卡就行（推荐）", value: "light_lowcal", hint: "正常吃但选健康餐" },
          { label: "严格控卡", value: "strict", hint: "只选同时有轻食、低卡标签的餐厅；实际热量需确认" },
          { label: "偶尔放纵", value: "cheat_day", hint: "今天不按减脂偏好筛选，仍保留已说明的忌口" },
        ],
        type: "single_choice",
      });
    }

    if (!group.preferences.budget) {
      questions.push({
        id: "budget",
        question: "今天的预算大概多少？",
        reason: "预算作为方案评分偏好，不是价格保证或强制上限",
        options: [
          { label: `节约（参考人均${BUDGET_TARGET.low}元）`, value: "low", hint: "性价比优先" },
          { label: `适中（参考人均${BUDGET_TARGET.medium}元）`, value: "medium", hint: "平衡花费与体验" },
          { label: `充裕（参考人均${BUDGET_TARGET.high}元）`, value: "high", hint: "接受更高花费" },
        ],
        type: "single_choice",
      });
    }

    return questions;
  }
}
