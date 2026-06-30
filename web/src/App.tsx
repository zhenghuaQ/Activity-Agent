import { useEffect, useState } from "react";
import DecisionPage from "./pages/DecisionPage.js";
import MonitorPage from "./pages/MonitorPage.js";
import ProfilePage from "./pages/ProfilePage.js";
import { listSegments } from "./api.js";
import type { SegmentInfo } from "./types.js";
import "./App.css";

type Tab = "decision" | "monitor" | "profile";

const TABS: { key: Tab; label: string }[] = [
  { key: "decision", label: "一键决策" },
  { key: "monitor", label: "监控面板" },
  { key: "profile", label: "用户画像" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("decision");
  const [segments, setSegments] = useState<SegmentInfo[]>([]);

  useEffect(() => {
    listSegments()
      .then(setSegments)
      .catch((err: unknown) => {
        console.warn("Failed to load segments, backend may be down:", err instanceof Error ? err.message : err);
      });
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="app-logo">Q</span>
          <div>
            <h1>帮你出行决策</h1>
          </div>
        </div>
        <nav className="app-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`tab ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {tab === "decision" && <DecisionPage segments={segments} />}
        {tab === "monitor" && <MonitorPage />}
        {tab === "profile" && <ProfilePage />}
      </main>

      <footer className="app-footer">
        <span>仅做决策，不含下单/支付/履约</span>
        <span>·</span>
        <a href="/docs" target="_blank" rel="noreferrer">
          API 文档
        </a>
      </footer>
    </div>
  );
}
