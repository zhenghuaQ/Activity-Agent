import type { FollowUpQuestion } from "./types.js";

/** 外部回答只携带选择；约束补丁由领域层计算，客户端不能任意改约束。 */
export interface FollowUpSelection { questionId: string; selectedValues: string[] }
export interface FollowUpRequest {
  requestId: string;
  runId: string;
  sessionId: string;
  expiresAt: number;
  questions: FollowUpQuestion[];
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2000;

export function isFollowUpQuestions(value: unknown): value is FollowUpQuestion[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8
    && new Set(value.map(q => record(q) ? q.id : undefined)).size === value.length
    && value.every(q => record(q) && text(q.id) && text(q.question) && typeof q.reason === "string"
      && q.type === "single_choice" && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 8
      && new Set(q.options.map(o => record(o) ? o.value : undefined)).size === q.options.length
      && q.options.every(o => record(o) && text(o.value) && text(o.label) && typeof o.hint === "string"));
}

export function parseFollowUpRequest(value: unknown): FollowUpRequest {
  if (!record(value) || !text(value.requestId) || !text(value.runId) || !text(value.sessionId)
    || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)
    || !isFollowUpQuestions(value.questions)) throw new Error("invalid_follow_up_request");
  return value as unknown as FollowUpRequest;
}

export function parseFollowUpSelections(value: unknown): FollowUpSelection[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8
    || !value.every(a => record(a) && text(a.questionId) && Array.isArray(a.selectedValues)
      && a.selectedValues.length === 1 && a.selectedValues.every(text)
      && Object.keys(a).every(k => k === "questionId" || k === "selectedValues"))
    || new Set(value.map(a => a.questionId)).size !== value.length) throw new Error("invalid_follow_up_answers");
  return value.map(a => ({ questionId: a.questionId, selectedValues: [...a.selectedValues] }));
}

export function validateFollowUpAnswers(questions: FollowUpQuestion[], value: unknown): FollowUpSelection[] {
  const answers = parseFollowUpSelections(value);
  if (answers.length !== questions.length || questions.some(q => {
    const answer = answers.find(a => a.questionId === q.id);
    return !answer || !q.options.some(o => o.value === answer.selectedValues[0]);
  })) throw new Error("invalid_follow_up_answers");
  return answers;
}
