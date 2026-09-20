import { useEffect, useRef, useState } from "react";
import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import { streamDecide, answerFollowUp, confirmConversationPlan, createConversation, getConversation } from "../api.js";
import type { FollowUpRequest } from "../../../spec/follow-up.js";
import type { ConversationTurn } from "../../../spec/conversation.js";
import {
  DimensionLabel,
  ObjectiveLabel,
  STAGE_ORDER,
  STAGE_LABEL,
} from "../constants.js";
import type {
  DoneEvent,
  PlanCandidate,
  PlanningStage,
  SegmentInfo,
  StageEvent,
} from "../types.js";

const EXAMPLES = [
  "带5岁娃和减肥老婆出去玩4-6小时",
  "陪爸妈逛逛，轻松点，半天时间",
  "二人世界，浪漫一点，预算充裕",
  "和朋友3人聚会，下午到晚上",
];

interface Props {
  segments: SegmentInfo[];
}

export default function DecisionPage({ segments }: Props) {
  const [conversationId, setConversationId] = useState(() => {
    const saved = window.localStorage.getItem("activity-agent-conversation");
    const created = saved || `conversation_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random()}`}`;
    window.localStorage.setItem("activity-agent-conversation", created); return created;
  });
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [planVersion, setPlanVersion] = useState<number>();
  const [acceptedVersion, setAcceptedVersion] = useState<number>();
  const [acceptedPlanId, setAcceptedPlanId] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState(EXAMPLES[0]);
  const [segment, setSegment] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [activeStage, setActiveStage] = useState<PlanningStage | null>(null);
  const [doneStages, setDoneStages] = useState<Set<PlanningStage>>(new Set());
  const [stageMsg, setStageMsg] = useState<string>("");
  const [result, setResult] = useState<DoneEvent | null>(null);
  const [error, setError] = useState<string>("");
  const [selectedPareto, setSelectedPareto] = useState<number>(-1);
  const stopRef = useRef<(() => void) | null>(null);
  const answerRef = useRef<AbortController | null>(null);
  const [followUp, setFollowUp] = useState<FollowUpRequest | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [answering, setAnswering] = useState(false);

  function clearFollowUp() {
    answerRef.current?.abort();
    answerRef.current = null;
    setFollowUp(null); setAnswers({}); setAnswering(false);
  }

  useEffect(() => {
    let active = true;
    void getConversation(conversationId).then(conversation => {
      if (!active || !conversation) return;
      setTurns(conversation.turns); setPlanVersion(conversation.memory.currentPlanVersion);
      setAcceptedVersion(conversation.memory.acceptedPlanVersion);
      const latest = conversation.plans.at(-1);
      if (latest) {
        setAcceptedPlanId(latest.acceptedAt ? latest.selectedPlan.id : undefined);
        const selectedIndex = latest.decision.pareto.findIndex(candidate => candidate.plan.id === latest.selectedPlan.id);
        setSelectedPareto(selectedIndex >= 0 ? selectedIndex : -1);
        setResult({ success: true, message: "已恢复上次方案", decision: latest.decision,
          selectedPlan: latest.selectedPlan, constraints: latest.constraints, notes: latest.decision.notes,
          conversationId, planVersion: latest.version });
      }
    }).catch(() => {});
    return () => { active = false; stopRef.current?.(); answerRef.current?.abort(); };
  }, [conversationId]);

  function reset() {
    clearFollowUp();
    setActiveStage(null);
    setDoneStages(new Set());
    setStageMsg("");
    setResult(null);
    setError("");
    setSelectedPareto(-1);
  }

  function run() {
    if (!text.trim() || running) return;
    reset();
    setRunning(true);
    const content = text.trim();
    setTurns(previous => [...previous, { id: `local_${Date.now()}`, role: "user", kind: "text", content, createdAt: Date.now() }]);

    const stop = streamDecide(
      {
        q: text.trim(),
        sessionId: conversationId,
        segment: (segment || undefined) as SegmentInfo["segment"] | undefined,
      },
      {
        onFollowUp: request => {
          clearFollowUp();
          setFollowUp(request);
          setActiveStage("follow_up_questions");
          setStageMsg("等待你补充偏好，提交后继续规划");
        },
        onStage: (e: StageEvent) => {
          if (STAGE_ORDER.indexOf(e.stage) >= STAGE_ORDER.indexOf("follow_up_questions")) clearFollowUp();
          setActiveStage(e.stage);
          setStageMsg(e.message);
          setDoneStages((prev) => {
            const next = new Set(prev);
            const idx = STAGE_ORDER.indexOf(e.stage);
            for (let i = 0; i < idx; i++) next.add(STAGE_ORDER[i]);
            return next;
          });
        },
        onDone: (e: DoneEvent) => {
          clearFollowUp();
          setResult(e);
          setDoneStages(new Set(STAGE_ORDER as PlanningStage[]));
          setActiveStage(null);
          setRunning(false);
          setPlanVersion(e.planVersion);
          setTurns(previous => [...previous, { id: `local_${Date.now()}`, role: "assistant", kind: "plan",
            content: e.message, createdAt: Date.now(), runId: e.runId, metadata: { planVersion: e.planVersion } }]);
          if (!e.success) setError(e.message);
        },
        onError: (e) => {
          clearFollowUp();
          setError(e.message);
          setRunning(false);
          setActiveStage(null);
        },
      }
    );
    stopRef.current = stop;
  }

  function stop() {
    clearFollowUp();
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
    setActiveStage(null);
  }

  async function submitAnswers() {
    if (!followUp || answerRef.current || followUp.questions.some(q => !answers[q.id])) return;
    const controller = new AbortController();
    answerRef.current = controller;
    setAnswering(true); setError("");
    try {
      await answerFollowUp(followUp, followUp.questions.map(q => ({ questionId: q.id, selectedValues: [answers[q.id]] })), controller.signal);
      if (controller.signal.aborted) return;
      setFollowUp(null); setStageMsg("回答已收到，正在继续规划");
      setTurns(previous => [...previous, { id: `local_${Date.now()}`, role: "user", kind: "choice",
        content: `已选择：${followUp.questions.map(q => q.options.find(o => o.value === answers[q.id])?.label).join("、")}`,
        createdAt: Date.now() }]);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "提交失败，请重试");
    } finally {
      if (answerRef.current === controller) { answerRef.current = null; setAnswering(false); }
    }
  }

  async function confirmCurrentPlan() {
    if (!planVersion || !selectedCandidate || confirming) return;
    setConfirming(true); setError("");
    try {
      const conversation = await confirmConversationPlan(conversationId, planVersion, selectedCandidate.plan.id);
      setAcceptedVersion(conversation.memory.acceptedPlanVersion); setAcceptedPlanId(selectedCandidate.plan.id);
      setTurns(conversation.turns);
    } catch (err) { setError(err instanceof Error ? err.message : "确认方案失败"); }
    finally { setConfirming(false); }
  }

  async function startNewConversation() {
    stop();
    const id = `conversation_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random()}`}`;
    window.localStorage.setItem("activity-agent-conversation", id);
    await createConversation(id).catch(() => undefined);
    setConversationId(id); setTurns([]); setPlanVersion(undefined); setAcceptedVersion(undefined);
    setAcceptedPlanId(undefined); reset();
  }

  const decision = result?.decision;
  const selectedCandidate: PlanCandidate | undefined =
    decision?.pareto?.[selectedPareto] ?? decision?.recommended;

  return (
    <div className="decision-page">
      <div className="card conversation-card">
        <div className="conversation-header"><div className="section-title">规划对话</div>
          <button className="btn-secondary" onClick={() => void startNewConversation()} disabled={running}>新建对话</button></div>
        {turns.length > 0 && <div className="conversation-turns">
          {turns.map(turn => <div key={turn.id} className={`conversation-turn ${turn.role}`}>
            <div className="turn-role">{turn.role === "user" ? "你" : "规划助手"}</div><div>{turn.content}</div>
          </div>)}
        </div>}
      </div>
      {/* 输入区 */}
      <div className="card decision-input-card">
        <div className="section-title">输入出行诉求</div>
        <div className="decision-input-row">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：带5岁娃和减肥老婆出去玩4-6小时"
            disabled={running}
            onKeyDown={(e) => e.key === "Enter" && run()}
          />
          <select value={segment} onChange={(e) => setSegment(e.target.value)} disabled={running}>
            <option value="">默认分层</option>
            {segments.map((s) => (
              <option key={s.segment} value={s.segment}>
                {s.label}
              </option>
            ))}
          </select>
          {running ? (
            <button className="btn-secondary" onClick={stop}>
              中止
            </button>
          ) : (
            <button className="btn-primary" onClick={run} disabled={!text.trim()}>
              一键决策
            </button>
          )}
        </div>
        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className="example-chip"
              onClick={() => !running && setText(ex)}
              disabled={running}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      {/* 阶段进度 */}
      {(running || doneStages.size > 0 || error) && (
        <div className="card stage-progress">
          <div className="section-title">规划进度</div>
          <div className="stage-list">
            {STAGE_ORDER.map((stage) => {
              const isDone = doneStages.has(stage);
              const isActive = activeStage === stage;
              const cls = isActive ? "active" : isDone ? "done" : "";
              return (
                <div key={stage} className={`stage-item ${cls}`}>
                  <div className="stage-dot" />
                  <div className="stage-label">{STAGE_LABEL[stage]}</div>
                  {isActive && stageMsg && <div className="stage-msg">{stageMsg}</div>}
                </div>
              );
            })}
          </div>
          {error && <div className="error-text" style={{ marginTop: 8 }}>{error}</div>}
        </div>
      )}

      {followUp && (
        <form className="card follow-up-card" onSubmit={event => { event.preventDefault(); void submitAnswers(); }}>
          <div className="section-title">补充偏好后继续规划</div>
          <p>请在 {new Date(followUp.expiresAt).toLocaleTimeString()} 前提交；超时或关闭页面将结束本次运行。</p>
          {followUp.questions.map(q => (
            <fieldset key={q.id} disabled={answering}>
              <legend>{q.question}</legend>
              <p>{q.reason}</p>
              {q.options.map(option => (
                <label key={option.value} className="follow-up-option">
                  <input type="radio" name={q.id} value={option.value} checked={answers[q.id] === option.value}
                    onChange={() => setAnswers(previous => ({ ...previous, [q.id]: option.value }))} />
                  <span>{option.label}<small>{option.hint}</small></span>
                </label>
              ))}
            </fieldset>
          ))}
          <button className="btn-primary" type="submit" disabled={answering || followUp.questions.some(q => !answers[q.id])}>
            {answering ? "提交中…" : "提交回答，继续规划"}
          </button>
        </form>
      )}

      {/* 决策结果 */}
      {decision && selectedCandidate && (
        <>
          {/* 主方案 + 雷达图 */}
          <div className="card plan-card">
            <div className="plan-card-header">
              <div>
                <span className={`objective-badge objective-${selectedCandidate.objective}`}>
                  {ObjectiveLabel[selectedCandidate.objective ?? "balanced"]}
                </span>
                <span style={{ fontWeight: 600 }}>
                  {selectedCandidate.plan.summary || "推荐方案"}
                </span>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="plan-score-total">
                  {selectedCandidate.plan.score?.total.toFixed(1) ?? "暂无评分"}
                </div>
                <div className="plan-confidence">
                  置信度 {((selectedCandidate.plan.score?.confidence ?? decision.confidence) * 100).toFixed(0)}%
                </div>
              </div>
            </div>
            {planVersion && <div className="plan-confirm-row">
              <button className={acceptedVersion === planVersion && acceptedPlanId === selectedCandidate.plan.id ? "btn-secondary" : "btn-primary"}
                disabled={confirming || (acceptedVersion === planVersion && acceptedPlanId === selectedCandidate.plan.id)} onClick={() => void confirmCurrentPlan()}>
                {acceptedVersion === planVersion && acceptedPlanId === selectedCandidate.plan.id
                  ? "已确认这个方案，仍可继续补充" : confirming ? "确认中…" : "这个方案可以"}
              </button>
            </div>}

            {/* 时间线 */}
            <div className="timeline">
              {selectedCandidate.plan.activities.map((act, i) => (
                <div key={i} className="timeline-item">
                  <div className="timeline-time">
                    {act.scheduledStart} → {act.scheduledEnd}
                  </div>
                  <div className="timeline-body">
                    <div className="timeline-name">
                      {act.place.name}
                      <span className={`timeline-type type-${act.place.type}`}>
                        {({ attraction: "景点", break: "茶歇", restaurant: "餐饮", delivery: "配送", walking: "漫步" })[act.place.type]}
                      </span>
                      {act.crowd?.level && (
                        <span className={`crowd-${act.crowd?.level}`} style={{ marginLeft: 8, fontSize: 12 }}>
                          {act.crowd?.level === "low" ? "空闲" : act.crowd?.level === "medium" ? "适中" : "拥挤"}
                        </span>
                      )}
                    </div>
                    {act.place.address && (
                      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                        {act.place.address}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* 可解释 */}
            <div style={{ marginTop: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>为什么推荐这个方案</div>
              {(selectedCandidate.plan.explanation?.highlights.length ?? 0) > 0 && (
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  <span style={{ color: "var(--success)", fontWeight: 600 }}>亮点：</span>
                  {selectedCandidate.plan.explanation?.highlights.join("；")}
                </div>
              )}
              {(selectedCandidate.plan.explanation?.tradeoffs.length ?? 0) > 0 && (
                <div style={{ fontSize: 13 }}>
                  <span style={{ color: "var(--warn)", fontWeight: 600 }}>取舍：</span>
                  {selectedCandidate.plan.explanation?.tradeoffs.join("；")}
                </div>
              )}
            </div>
          </div>

          {/* 雷达图 */}
          <div className="card">
            <div className="section-title">多维评分（6 维）</div>
            <div className="radar-container">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart
                  data={(selectedCandidate.plan.score?.dimensions ?? []).map((d) => ({
                    dimension: DimensionLabel[d.dimension],
                    score: Math.round(d.score),
                    weight: Math.round(d.weight * 100),
                  }))}
                >
                  <PolarGrid />
                  <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 12 }} />
                  <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 10 }} />
                  <Radar
                    name="评分"
                    dataKey="score"
                    stroke="#f0a500"
                    fill="#ffc300"
                    fillOpacity={0.5}
                  />
                  <Tooltip
                    formatter={(v: number, n: string) => [v, n === "score" ? "评分" : "权重%"]}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* 帕累托对比 */}
          {decision.pareto.length > 1 && (
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <div className="section-title">帕累托多方案对比（点击切换）</div>
              <div className="pareto-grid">
                {decision.pareto.map((c, i) => (
                  <div
                    key={`${c.plan.id}-${c.objective ?? i}`}
                    className={`pareto-card ${(selectedPareto < 0 ? c.plan.id === decision.recommended.plan.id : i === selectedPareto) ? "selected" : ""}`}
                    onClick={() => setSelectedPareto(i)}
                  >
                    <div className="pareto-header">
                      <span className={`objective-badge objective-${c.objective}`}>
                        {ObjectiveLabel[c.objective ?? "balanced"]}
                      </span>
                      <span className="pareto-score">{c.plan.score?.total.toFixed(1) ?? "暂无评分"}</span>
                    </div>
                    <div style={{ fontSize: 13 }}>
                      通勤 {c.plan.totalTransitMinutes}min · 总时长 {Math.round(c.plan.totalDurationHours * 60)}min
                    </div>
                    <div className="pareto-places">
                      {c.plan.activities.map((a) => a.place.name).join(" → ")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 备注 */}
          {result?.notes && result.notes.length > 0 && (
            <div className="notes-list" style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>规划说明</div>
              <ul>
                {result.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
