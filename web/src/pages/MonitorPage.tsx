import { useCallback, useEffect, useState } from "react";
import { getFlags, getHealth, getMetrics, setFlags } from "../api.js";
import type { HealthInfo, MetricsSnapshot, RuntimeFlags } from "../types.js";

export default function MonitorPage() {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [flags, setFlagsState] = useState<RuntimeFlags | null>(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      const [m, h, f] = await Promise.all([getMetrics(), getHealth(), getFlags()]);
      setMetrics(m);
      setHealth(h);
      setFlagsState(f);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function toggleFlag(key: keyof RuntimeFlags) {
    if (!flags) return;
    const next = { ...flags, [key]: !flags[key] };
    try {
      const updated = await setFlags({ [key]: next[key] });
      setFlagsState(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error && !metrics) {
    return (
      <div className="card">
        <div className="error-text">连接后端失败：{error}</div>
        <button className="btn-primary" style={{ marginTop: 12 }} onClick={refresh}>
          重试
        </button>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
          请确认后端已启动：<code>npm run serve</code>（端口 3000）
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 16 }}>
        <div className="section-title" style={{ margin: 0 }}>运行时监控</div>
        <div className="row">
          <span style={{ fontSize: 12, color: "var(--muted)" }}>
            自动刷新 5s · {refreshing ? "刷新中..." : "已就绪"}
          </span>
          <button className="btn-secondary" onClick={refresh} disabled={refreshing}>
            刷新
          </button>
        </div>
      </div>

      {/* 健康状态 */}
      {health && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="row-between">
            <div>
              <span style={{ fontWeight: 600 }}>服务状态：</span>
              <span style={{ color: "var(--success)", fontWeight: 600 }}>{health.status}</span>
              <span style={{ marginLeft: 12, color: "var(--muted)" }}>v{health.version}</span>
              <span style={{ marginLeft: 12, color: "var(--muted)" }}>env: {health.env}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              运行 {Math.floor(health.uptimeMs / 60000)}min
            </div>
          </div>
        </div>
      )}

      {/* 指标卡片 */}
      {metrics?.runtime && metrics.subscribers && <div className="card" style={{ marginBottom: 16 }}>
        <div className="section-title">任务与事件交付</div>
        <p>运行中 {metrics.runtime.activeRuns} · 排队 {metrics.runtime.queued} · 任务拒绝 {metrics.runtime.rejected}</p>
        <p>订阅待处理 {metrics.subscribers.pending} · 交付失败 {metrics.subscribers.failed} · 交付拒绝 {metrics.subscribers.rejected}</p>
        <p>累计处理耗时 {metrics.subscribers.processingMs}ms</p>
      </div>}
      {metrics && (
        <div className="monitor-grid">
          <div className="metric-card">
            <div className="metric-label">总请求</div>
            <div className="metric-value">{metrics.requests}</div>
            <div className="metric-sub">{metrics.errors} 错误</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">决策次数</div>
            <div className="metric-value">{metrics.decisions}</div>
            <div className="metric-sub">
              {metrics.degraded} 降级（{metrics.decisions > 0 ? Math.round((metrics.degraded / metrics.decisions) * 100) : 0}%）
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-label">限流拦截</div>
            <div className="metric-value">{metrics.rateLimited}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">平均时延</div>
            <div className="metric-value">{metrics.latency.avgMs}ms</div>
            <div className="metric-sub">p95: {metrics.latency.p95Ms}ms</div>
          </div>
        </div>
      )}

      {/* 路由表 */}
      {metrics && Object.keys(metrics.routes).length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-title">路由统计</div>
          <table className="routes-table">
            <thead>
              <tr>
                <th>路由</th>
                <th>请求数</th>
                <th>错误数</th>
                <th>平均耗时</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(metrics.routes).map(([route, stat]) => (
                <tr key={route}>
                  <td><code>{route}</code></td>
                  <td>{stat.count}</td>
                  <td style={{ color: stat.errors > 0 ? "var(--danger)" : undefined }}>{stat.errors}</td>
                  <td>{stat.avgMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 降级开关 */}
      {flags && (
        <div className="card">
          <div className="section-title">运行时降级开关（可热切）</div>
          <div className="flags-row">
            <div>
              <div className="flag-label">限流</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>关闭后所有请求放行</div>
            </div>
            <div className="flag-value">
              <span style={{ fontSize: 12, color: flags.rateLimit ? "var(--success)" : "var(--muted)" }}>
                {flags.rateLimit ? "ON" : "OFF"}
              </span>
              <button className={`toggle ${flags.rateLimit ? "on" : ""}`} onClick={() => toggleFlag("rateLimit")} />
            </div>
          </div>
          <div className="flags-row">
            <div>
              <div className="flag-label">强制 Mock 意图解析</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>跳过 LLM，用关键词解析（降级演示）</div>
            </div>
            <div className="flag-value">
              <span style={{ fontSize: 12, color: flags.forceMockIntent ? "var(--danger)" : "var(--muted)" }}>
                {flags.forceMockIntent ? "ON" : "OFF"}
              </span>
              <button className={`toggle ${flags.forceMockIntent ? "on" : ""}`} onClick={() => toggleFlag("forceMockIntent")} />
            </div>
          </div>
          <div className="flags-row">
            <div>
              <div className="flag-label">缓存</div>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>信息性，反映配置</div>
            </div>
            <div className="flag-value">
              <span style={{ fontSize: 12, color: flags.cache ? "var(--success)" : "var(--muted)" }}>
                {flags.cache ? "ON" : "OFF"}
              </span>
              <button className={`toggle ${flags.cache ? "on" : ""}`} onClick={() => toggleFlag("cache")} />
            </div>
          </div>
        </div>
      )}

      {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
