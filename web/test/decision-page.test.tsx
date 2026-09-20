// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DecisionPage from "../src/pages/DecisionPage.js";
import { ErrorBoundary } from "../src/ErrorBoundary.js";
import { decisionFixture } from "../../test/fixtures/decision.js";

// 图表布局依赖真实尺寸；本组验证页面数据与交互，图表保留容器。
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  RadarChart: () => <div>评分图</div>, Radar: () => null, PolarGrid: () => null,
  PolarAngleAxis: () => null, PolarRadiusAxis: () => null, Tooltip: () => null,
}));

class Source {
  static current: Source;
  close = vi.fn();
  listeners = new Map<string, (event: { data: string }) => void>();
  constructor() { Source.current = this; }
  addEventListener(type: string, handler: (event: { data: string }) => void) { this.listeners.set(type, handler); }
  emit(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
}
let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("EventSource", Source);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ErrorBoundary><DecisionPage segments={[]} /></ErrorBoundary>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(b => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

describe("一键决策页面", () => {
  const followUp = { requestId: "question_test", runId: "run_test", sessionId: "session_test", expiresAt: Date.now() + 120000,
    questions: [{ id: "budget", question: "今天预算多少？", reason: "控制花费", type: "single_choice", options: [
      { value: "low", label: "人均100以内", hint: "节约" }, { value: "high", label: "200以上", hint: "品质" }] }] };

  it("展示追问，未选择不能提交，回答后沿原连接接收结果", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accepted: true, requestId: followUp.requestId }) });
    vi.stubGlobal("fetch", fetch);
    await click("一键决策");
    const source = Source.current;
    await act(async () => source.emit("follow_up", followUp));
    expect(host.textContent).toContain("今天预算多少？");
    expect(host.querySelector(".plan-card")).toBeNull();
    expect((host.querySelector("button[type=submit]") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => (host.querySelector("input[type=radio]") as HTMLInputElement).click());
    await click("提交回答，继续规划");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ requestId: followUp.requestId,
      sessionId: followUp.sessionId, runId: followUp.runId, answers: [{ questionId: "budget", selectedValues: ["low"] }] });
    expect(Source.current).toBe(source);
    expect(source.close).not.toHaveBeenCalled();
    expect(host.querySelector(".follow-up-card")).toBeNull();
    await act(async () => source.emit("done", decisionFixture()));
    expect(host.querySelector(".plan-card")).not.toBeNull();
  });

  it("提交失败保留选项可重试；中止后忽略迟到的回答请求结果", async () => {
    let reject!: (reason: unknown) => void;
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ message: "请重新选择" }) })
      .mockImplementationOnce(() => new Promise((_resolve, rej) => { reject = rej; }));
    vi.stubGlobal("fetch", fetch);
    await click("一键决策");
    await act(async () => Source.current.emit("follow_up", followUp));
    await act(async () => (host.querySelector("input[type=radio]") as HTMLInputElement).click());
    await click("提交回答，继续规划");
    expect(host.textContent).toContain("请重新选择");
    expect((host.querySelector("input[type=radio]") as HTMLInputElement).checked).toBe(true);
    await click("提交回答，继续规划");
    const signal = fetch.mock.calls[1][1].signal as AbortSignal;
    await click("中止");
    expect(signal.aborted).toBe(true);
    await click("一键决策");
    await act(async () => reject(new Error("迟到的失败")));
    expect(host.textContent).not.toContain("迟到的失败");
    expect(host.querySelector(".follow-up-card")).toBeNull();
  });

  it("后续阶段先于回答 HTTP 响应到达时，不会留下过期表单", async () => {
    let resolve!: (response: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise(r => { resolve = r; })));
    await click("一键决策");
    await act(async () => Source.current.emit("follow_up", followUp));
    await act(async () => (host.querySelector("input[type=radio]") as HTMLInputElement).click());
    await click("提交回答，继续规划");
    await act(async () => Source.current.emit("done", decisionFixture()));
    await act(async () => resolve({ ok: true, json: async () => ({ accepted: true, requestId: followUp.requestId }) }));
    expect(host.querySelector(".plan-card")).not.toBeNull();
    expect(host.querySelector(".follow-up-card")).toBeNull();
  });

  it("完成后显示方案、时间和评分，并可切换方案", async () => {
    await click("一键决策");
    await act(async () => Source.current.emit("done", decisionFixture()));
    expect(host.querySelector(".plan-card")?.textContent).toContain("公园方案");
    expect(host.textContent).toContain("14:00");
    expect(host.textContent).toContain("80.0");
    await act(async () => (host.querySelectorAll(".pareto-card")[1] as HTMLElement).click());
    expect(host.querySelector(".plan-card")?.textContent).toContain("展览方案");
    expect(Source.current.close).toHaveBeenCalledOnce();
  });

  it("取消后忽略旧请求结果，允许重新开始", async () => {
    await click("一键决策");
    const old = Source.current;
    await click("中止");
    await click("一键决策");
    await act(async () => old.emit("done", decisionFixture()));
    expect(host.querySelector(".plan-card")).toBeNull();
    await act(async () => Source.current.emit("done", decisionFixture()));
    expect(host.querySelector(".plan-card")).not.toBeNull();
  });

  it("结构错误与网络断开显示提示，页面仍可重试", async () => {
    await click("一键决策");
    await act(async () => Source.current.emit("done", { success: true, decision: { recommended: {} } }));
    expect(host.textContent).toContain("决策结果解析失败");
    await click("一键决策");
    await act(async () => Source.current.emit("error", undefined));
    expect(host.textContent).toContain("连接异常");
    await click("一键决策");
    await act(async () => Source.current.emit("done", decisionFixture()));
    expect(host.querySelector(".plan-card")).not.toBeNull();
  });

  it("渲染异常有兜底，恢复后可以重新渲染", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const expectedError = (event: ErrorEvent) => { if (event.message === "render failure") event.preventDefault(); };
    window.addEventListener("error", expectedError);
    let broken = true;
    function Child() { if (broken) throw new Error("render failure"); return <div>恢复成功</div>; }
    await act(async () => root.render(<ErrorBoundary><Child /></ErrorBoundary>));
    expect(host.textContent).toContain("页面暂时无法显示");
    broken = false;
    await click("重新加载页面内容");
    expect(host.textContent).toContain("恢复成功");
    window.removeEventListener("error", expectedError);
  });
});
