import type { FollowUpAnswer, FollowUpQuestion, StructuredConstraints } from "../../spec/types.js";
import { validateFollowUpAnswers, type FollowUpSelection } from "../../spec/follow-up.js";

/** 问题 ID 和选择是领域协议，绝不执行来自客户端/LLM 的 patches。 */
export function interpretFollowUpAnswers(constraints: StructuredConstraints, questions: FollowUpQuestion[], input: FollowUpSelection[]): FollowUpAnswer[] {
  const selections = validateFollowUpAnswers(questions, input);
  let restrictions = [...constraints.group.preferences.dietaryRestrictions];
  return selections.map(answer => {
    const value = answer.selectedValues[0];
    const patches: FollowUpAnswer["patches"] = {};
    switch (answer.questionId) {
      case "budget":
        if (!["low", "medium", "high"].includes(value)) throw new Error("unsupported_follow_up_value");
        patches.budget = value as "low" | "medium" | "high";
        break;
      case "elderly_dietary":
        if (!["none", "light", "soft"].includes(value)) throw new Error("unsupported_follow_up_value");
        // 不清除原有过敏/忌口；“无特殊要求”只是不增加约束。
        restrictions = [...new Set([...restrictions, ...(value === "soft" ? ["软食", "轻油盐"] : value === "light" ? ["轻油盐"] : [])])];
        patches.dietaryRestrictions = [...restrictions];
        break;
      case "dieting_level":
        if (!["light_lowcal", "strict", "cheat_day"].includes(value)) throw new Error("unsupported_follow_up_value");
        patches.dieting = value !== "cheat_day";
        restrictions = [...new Set([...restrictions, ...(value === "strict" ? ["低卡", "轻食"] : value === "light_lowcal" ? ["低卡"] : [])])];
        patches.dietaryRestrictions = [...restrictions];
        break;
      case "trip_style":
        if (!["city_classic", "food_date", "slow_travel"].includes(value)) throw new Error("unsupported_follow_up_value");
        patches.extraHints = value === "city_classic" ? ["城市地标", "历史文化"]
          : value === "food_date" ? ["美食", "浪漫"] : ["休闲慢游", "少赶路"];
        break;
      default: throw new Error("unsupported_follow_up_question");
    }
    return { ...answer, patches };
  });
}
