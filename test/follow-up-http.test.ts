import { expect, it, vi } from "vitest";
import { buildServer } from "../src/server/app.js";
import { defaultAgentEventBus, defaultAgentRuntime } from "../src/runtime/index.js";
import { getRuntimeFlags, setRuntimeFlags } from "../src/server/flags.js";
import type { AgentEventOf } from "../spec/agent-event.js";
import { parseDecisionResponse } from "../spec/decision-response.js";

vi.mock("../src/llm/followup.js", () => ({ generateFollowUpWithLLM: async () => [] }));

it("Fastify 完整路由：流中等待 → POST answer → 原连接返回决策", async () => {
  const flags = getRuntimeFlags();
  setRuntimeFlags({ forceMockIntent: true });
  const app = buildServer();
  let resolve!: (event: AgentEventOf<"follow_up_requested">) => void;
  const question = new Promise<AgentEventOf<"follow_up_requested">>(r => { resolve = r; });
  const observer = defaultAgentEventBus.subscribe({ id: "http-follow-up-test", matches: e => e.type === "follow_up_requested",
    handle: event => { if (event.type === "follow_up_requested") resolve(event); } });
  try {
    const response = app.inject({ method: "GET", url: `/api/decide/stream?interactive=1&q=${encodeURIComponent("带娃出去玩4小时")}` }).then(r => r);
    const event = await question;
    expect(defaultAgentRuntime.router.getActiveRun(event.scope.runId)?.status).toBe("waiting_input");
    const payload = { sessionId: event.scope.sessionId, runId: event.scope.runId, requestId: event.payload.requestId,
      answers: event.payload.questions.map(q => ({ questionId: q.id, selectedValues: [q.options[0].value] })) };
    const accepted = await app.inject({ method: "POST", url: "/api/decide/answer", payload });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ accepted: true, requestId: event.payload.requestId });
    const res = await response;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body).toContain("event: follow_up");
    const doneFrame = res.body.split("\n\n").find(frame => frame.startsWith("event: done"))!;
    const result = JSON.parse(doneFrame.split("data: ")[1]);
    expect(result.runId).toBe(event.scope.runId);
    expect(parseDecisionResponse(result).success).toBe(true);
    const duplicate = await app.inject({ method: "POST", url: "/api/decide/answer", payload });
    expect(duplicate.statusCode).toBe(409);
    expect(defaultAgentRuntime.router.snapshot().activeRuns).toBe(0);
  } finally {
    observer.close(); defaultAgentRuntime.shutdown(); setRuntimeFlags(flags); await app.close();
  }
});
