// ============================================================
// src/tools/followup.ts — Tool 6: generate_followup_questions
// v2: LLM 优先 + Mock 降级
// ============================================================

import type { FollowUpQuestion, LeadRole, StructuredConstraints } from "../../spec/types.js";
import { LeadRoleStrategy } from "../../spec/types.js";
import type * as T from "../../spec/tools.js";
import { GENERATE_FOLLOWUP_TOOL } from "../../spec/tools.js";
import { BaseTool } from "./base.js";
import { generateFollowUpWithLLM } from "../llm/followup.js";

export class GenerateFollowUpTool extends BaseTool<
  T.GenerateFollowUpInput,
  T.GenerateFollowUpOutput
> {
  name = "generate_followup_questions";
  description = GENERATE_FOLLOWUP_TOOL.description;
  inputSchema = GENERATE_FOLLOWUP_TOOL.inputSchema;

  async run(input: T.GenerateFollowUpInput): Promise<FollowUpQuestion[]> {
    const { group } = input.constraints;
    const strategy = LeadRoleStrategy[group.leadRole];

    if (!strategy.needsFollowUp) return [];

    // 尝试 LLM 生成；未配置/失败时返回 []，降级为硬编码追问
    const llmResult = await generateFollowUpWithLLM(input.constraints);
    if (llmResult.length > 0) {
      return llmResult;
    }

    // 降级为硬编码追问
    return this.mockFollowUp(group.leadRole, group);
  }

  private mockFollowUp(leadRole: LeadRole, group: StructuredConstraints["group"]): FollowUpQuestion[] {
    const questions: FollowUpQuestion[] = [];

    if (leadRole === "kids") {
      questions.push({
        id: "kids_age_tolerance",
        question: "孩子多大？有什么特别需要注意的吗？",
        reason: "5岁以下和10岁以上玩的差别很大，需要确认",
        options: [
          { label: "5岁以下（推荐）", value: "under5", hint: "亲子乐园、室内游乐、儿童餐厅" },
          { label: "5-10岁", value: "age5_10", hint: "科技馆、动物园、户外探索" },
          { label: "10-15岁", value: "age10_15", hint: "卡丁车、攀岩、VR体验" },
        ],
        type: "single_choice",
      });
    }

    if (leadRole === "elderly") {
      questions.push({
        id: "elderly_dietary",
        question: "老人有什么饮食忌口吗？",
        reason: "老年人通常需要少油盐、软食，想确认一下",
        options: [
          { label: "少油少盐即可", value: "light", hint: "推荐清淡本地菜" },
          { label: "需要软食/易消化", value: "soft", hint: "推荐粥品、蒸菜" },
          { label: "无特殊要求", value: "none", hint: "按正常口味推荐" },
        ],
        type: "single_choice",
      });
      questions.push({
        id: "elderly_mobility",
        question: "老人行动方便吗？",
        reason: "决定景点是否需要无障碍设施和休息频率",
        options: [
          { label: "行动自如（推荐）", value: "mobile", hint: "续航充足，每日1-2个景点" },
          { label: "需要轮椅/拐杖", value: "limited", hint: "只选有电梯、平路的室内景点" },
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
          { label: "严格控卡", value: "strict", hint: "只推沙拉/轻食专门店，避开煎炸" },
          { label: "偶尔放纵", value: "cheat_day", hint: "减肥是认真的，但今天是Cheat Day！" },
        ],
        type: "single_choice",
      });
    }

    if (!group.preferences.budget) {
      questions.push({
        id: "budget",
        question: "今天的预算大概多少？",
        reason: "帮你控制在预算内安排",
        options: [
          { label: "人均100以内", value: "low", hint: "性价比优先，大众消费" },
          { label: "人均100-200（推荐）", value: "medium", hint: "品质不错的餐厅+热门景点" },
          { label: "人均200以上", value: "high", hint: "精致餐饮+VIP体验" },
        ],
        type: "single_choice",
      });
    }

    return questions;
  }
}