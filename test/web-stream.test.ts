import { afterEach, describe, expect, it, vi } from "vitest";
import { streamDecide } from "../web/src/api.js";
import { decisionFixture } from "./fixtures/decision.js";

class FakeEventSource {
  static CLOSED = 2;
  static current: FakeEventSource;
  readyState = 1;
  listeners = new Map<string, (event: unknown) => void>();
  close = vi.fn(() => { this.readyState = FakeEventSource.CLOSED; });
  constructor(public url: string) { FakeEventSource.current = this; }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, listener);
  }
  emit(type: string, data?: string) { this.listeners.get(type)?.({ data }); }
}

function connect() {
  vi.stubGlobal("window", { location: { origin: "http://localhost:5173" } });
  vi.stubGlobal("EventSource", FakeEventSource);
  const handlers = { onDone: vi.fn(), onError: vi.fn(), onStage: vi.fn() };
  const stop = streamDecide({ q: "家庭出游" }, handlers);
  return { ...handlers, stop, source: FakeEventSource.current };
}

afterEach(() => vi.unstubAllGlobals());

describe("决策页面 SSE 接入", () => {
  it("合法 JSON 但结构错误也进入错误回调", () => {
    const { source, onDone, onError } = connect();
    source.emit("done", JSON.stringify({ success: true, message: "ok", notes: [] }));
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("浏览器已标为 CLOSED 的连接失败仍反馈", () => {
    const { source, onError } = connect();
    source.readyState = FakeEventSource.CLOSED;
    source.emit("error");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("完成后交付结果并关闭连接", () => {
    const { source, onDone, onError } = connect();
    const result = decisionFixture();
    source.emit("done", JSON.stringify(result));
    expect(onDone).toHaveBeenCalledWith(result);
    expect(onError).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("损坏的结果报告错误，避免页面一直加载", () => {
    const { source, onDone, onError } = connect();
    source.emit("done", "{invalid");
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith({ message: "决策结果解析失败，请重试" });
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("保留服务端错误说明", () => {
    const { source, onError } = connect();
    source.emit("error", JSON.stringify({ message: "请求过于频繁，请稍后重试" }));
    expect(onError).toHaveBeenCalledWith({ message: "请求过于频繁，请稍后重试" });
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("网络断开显示提示；手动中止后的关闭事件不报错", () => {
    const first = connect();
    first.source.emit("error");
    expect(first.onError).toHaveBeenCalledWith({ message: "连接异常，请确认后端服务可用" });
    const second = connect();
    second.stop();
    second.source.emit("error");
    expect(second.onError).not.toHaveBeenCalled();
  });
});
