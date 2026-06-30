// ============================================================
// src/llm/followup.ts — LLM 追问生成（OpenAI 兼容接口）
// 替代 src/tools/followup.ts 中的硬编码模板
// ============================================================

import type { FollowUpQuestion, StructuredConstraints } from "../../spec/types.js";
import { getLLMClient, getLLMConfig } from "./config.js";
import type { ToolResult } from "../../spec/types.js";
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
  constraints: StructuredConstraints
): Promise<ToolResult<FollowUpQuestion[]>> {
  const client = getLLMClient();
  const config = getLLMConfig();

  if (!client || !config.enabled) {
    return {
      status: "degraded",
      data: [],
      trace: { toolName: "generate_followup_questions", input: "llm_disabled", timestamp: Date.now(), latencyMs: 0, output: null },
      reason: "LLM not configured, skipping follow-up",
    };
  }

  const t0 = Date.now();
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
    });

    const toolCall = resp.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function") {
      return { status: "degraded", data: [], trace: { toolName: "generate_followup_questions", input: "no_tool_call", timestamp: t0, latencyMs: Date.now() - t0, output: null }, reason: "LLM returned no tool call" };
    }

    const parsed = JSON.parse(toolCall.function.arguments);
    const questions: FollowUpQuestion[] = (parsed.questions || []).map((q: Record<string, unknown>) => ({
      ...q,
      type: "single_choice" as const,
    }));

    log.info({ count: questions.length }, "追问生成完成");
    return {
      status: "ok",
      data: questions,
      trace: { toolName: "generate_followup_questions", input: `followup_for_${group.leadRole}`, timestamp: t0, latencyMs: Date.now() - t0, output: null },
    };
  } catch (err) {
    // Silently fallback
    return {
      status: "degraded",
      data: [],
      trace: { toolName: "generate_followup_questions", input: "error", timestamp: t0, latencyMs: Date.now() - t0, output: null },
      reason: "Follow-up generation failed: " + (err instanceof Error ? err.message : String(err)),
    };
  }
}