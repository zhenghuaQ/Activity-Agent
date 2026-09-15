// ============================================================
// src/llm/followup.ts — LLM 追问生成（OpenAI 兼容接口）
//
// 内部辅助函数（非 Tool）：未配置/失败/无工具调用均返回 []，
// 由调用方降级到硬编码模板追问。
// ============================================================

import type { FollowUpQuestion, StructuredConstraints } from "../../spec/types.js";
import { getLLMClient, getLLMConfig } from "./config.js";
import { childLogger } from "../core/logger.js";

const log = childLogger("llm:followup");

const FOLLOWUP_SCHEMA = {
  name: "generate_followup_questions",
  description: "Generate 1-3 follow-up questions to confirm user preferences",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            question: { type: "string" },
            reason: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  value: { type: "string" },
                  hint: { type: "string" },
                },
                required: ["label", "value", "hint"],
              },
            },
          },
          required: ["id", "question", "reason", "options"],
        },
        maxItems: 3,
      },
    },
    required: ["questions"],
  },
};

export async function generateFollowUpWithLLM(
  constraints: StructuredConstraints,
  signal?: AbortSignal
): Promise<FollowUpQuestion[]> {
  const client = getLLMClient();
  const config = getLLMConfig();

  if (!client || !config.enabled) {
    return [];
  }

  try {
    log.info("生成追问中");
    const { group } = constraints;
    const resp = await client.chat.completions.create({
      model: config.model,
      messages: [
        {
          role: "system",
          content:
            "You are a follow-up module for a trip planner. Generate 1-3 questions to confirm user preferences. Only ask when necessary (kids/elderly scenarios). Keep questions concise and conversational.",
        },
        {
          role: "user",
          content: JSON.stringify({
            scenario: group.scenario,
            leadRole: group.leadRole,
            totalPeople: group.totalPeople,
            hasYoungChild: group.ageGroup.youngChildren > 0,
            hasSenior: group.ageGroup.seniors > 0,
            dieting: group.preferences.dieting,
            dietaryRestrictions: group.preferences.dietaryRestrictions,
          }),
        },
      ],
      tools: [{ type: "function", function: FOLLOWUP_SCHEMA }],
      tool_choice: { type: "function", function: { name: "generate_followup_questions" } },
      temperature: 0.3,
      max_tokens: 600,
    }, signal ? { signal } : undefined);

    const toolCall = resp.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function") {
      log.warn("LLM 未返回 tool call，使用模板追问");
      return [];
    }

    const parsed = JSON.parse(toolCall.function.arguments);
    const questions: FollowUpQuestion[] = (parsed.questions || []).map(
      (q: Record<string, unknown>) => ({
        ...q,
        type: "single_choice" as const,
      })
    );

    log.info({ count: questions.length }, "追问生成完成");
    return questions;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "追问生成失败，使用模板");
    return [];
  }
}
