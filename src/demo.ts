import "dotenv/config";
// ============================================================
// src/demo.ts — 多轮对话交互式 CLI Demo（一键决策）
//
// 产品定位：核心竞争力是「一键决策」，不做下单/预订/取号/支付。
//
// Round 1: 用户随口说 → Agent 解析意图 → 展示初步推断
// Round 2: 追问确认 → 用户选择 → 生成方案
// Round 3: 展示方案 + 备选 → 用户可微调
// Round 4: 输出最终决策方案（可解释 / 可分享），结束
// ============================================================

import * as readline from "readline";
// import { parseIntent } from "./intent/parser.js"; // 已被 LLM 替代
import {
  stage1_parseIntent,
  stage2_followUp,
  stage3_generateCandidates,
  stage4_feasibilityCheck,
  stage5_selectBest,
} from "./planner/engine.js";
import type {
  Plan,
  FollowUpQuestion,
  FollowUpAnswer,
  PlanningState,
  Restaurant,
} from "../spec/types.js";
import { LeadRoleStrategy } from "../spec/types.js";
import { DimensionLabel, ObjectiveLabel } from "../spec/decision.js";
import type { UserProfile } from "../spec/profile.js";
import {
  ALL_SEGMENTS,
  getSegmentProfile,
  createProfile,
  resolveWeights,
  applyProfileToConstraints,
} from "./profile/index.js";

/** 本次会话选定的用户画像（个性化） */
let activeProfile: UserProfile | null = null;

// ─── 交互工具 ────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

// ─── 格式化输出 ──────────────────────────────────────

const D = "─".repeat(52);

function header() {
  console.log(`\n  ╔${"═".repeat(50)}╗`);
  console.log("  ║     🧭  AI出行决策 Agent — 多轮对话版    ║");
  console.log(`  ╚${"═".repeat(50)}╝`);
}

function stage(label: string) {
  console.log(`\n  ${label}`);
}

function step(label: string, content: string) {
  console.log(`    ${label} ${content}`);
}

function warn(content: string) {
  console.log(`  ⚠ ${content}`);
}

function error(content: string) {
  console.log(`  ✗ ${content}`);
}

// ─── 展示方案（紧凑版） ──────────────────────────────

function showPlanBriefly(plan: Plan): string[] {
  const lines: string[] = [];
  for (const act of plan.activities) {
    const icon =
      act.place.type === "break" ? "☕️"
      : act.place.type === "attraction" ? "🎯"
      : "🍽️";
    const transit = act.transitTo ? `  🚗${act.transitTo.totalMinutes}min` : "";
    const price = act.place.pricePerPerson ? ` ¥${act.place.pricePerPerson}/人` : "";
    const queue =
      act.place.type === "restaurant"
        ? `  [排队${(act.place as Restaurant).queueCount ?? 0}人]`
        : "";

    lines.push(
      `    ${act.scheduledStart}→${act.scheduledEnd}  ${icon} ${act.place.name}${price}${queue}${transit}`
    );
  }
  return lines;
}

function showPlanDetail(plan: Plan) {
  const headline = plan.score
    ? `综合 ${plan.score.total}分 · 置信度 ${(plan.score.confidence * 100).toFixed(0)}%`
    : `${plan.feasibilityScore}分`;
  console.log(`\n  📋 推荐方案 (${headline})`);
  console.log(`     ${plan.summary}`);
  console.log(`     总时长 ${plan.totalDurationHours}h | 通勤 ${plan.totalTransitMinutes}min`);
  console.log();
  for (const line of showPlanBriefly(plan)) {
    console.log(line);
  }

  // M2 多维评分明细
  if (plan.score) {
    console.log(`\n     📊 多维评分:`);
    for (const d of [...plan.score.dimensions].sort((a, b) => b.weighted - a.weighted)) {
      const bar = "█".repeat(Math.round(d.score / 10)).padEnd(10, "·");
      console.log(
        `        ${DimensionLabel[d.dimension].padEnd(4)} ${bar} ${String(d.score).padStart(3)}  (权重${(d.weight * 100).toFixed(0)}%) ${d.reason}`
      );
    }
  }

  // M2 可解释
  if (plan.explanation) {
    if (plan.explanation.highlights.length > 0) {
      console.log(`\n     ✨ 亮点:`);
      for (const h of plan.explanation.highlights) console.log(`        + ${h}`);
    }
    if (plan.explanation.tradeoffs.length > 0) {
      console.log(`     ⚖️  取舍:`);
      for (const t of plan.explanation.tradeoffs) console.log(`        - ${t}`);
    }
  }
}

// ─── Round 1: 解析意图 ───────────────────────────────

async function round1_parseIntent(state: PlanningState): Promise<PlanningState> {
  stage("📝 Round 1: 今天怎么安排？");

  const input = await ask("  👤 随便说: ");
  if (!input.trim()) {
    return await round1_parseIntent(state);
  }

  state = await stage1_parseIntent(state, input);

  // 个性化：把画像偏好并入约束
  if (activeProfile) {
    state.constraints = applyProfileToConstraints(state.constraints!, activeProfile);
  }

  const c = state.constraints!;
  const strategy = LeadRoleStrategy[c.group.leadRole];

  console.log(`\n  🤖 我理解：${strategy.description}`);
  step("👥", `${c.group.totalPeople}人 | ${strategy.label}`);
  step("⏰", `${c.timeWindow.start}→${c.timeWindow.end}，约${c.timeWindow.durationHours}h`);
  step("📍", `${c.distance.homeLocation.address} 周边 ≤${c.distance.maxKm}km`);

  if (c.group.preferences.dieting) step("🥗", "有人正在减肥，注意饮食");
  if (c.group.preferences.dietaryRestrictions.length > 0)
    step("🚫", `忌口: ${c.group.preferences.dietaryRestrictions.join("、")}`);
  if (c.group.ageGroup.seniors > 0) step("👴", `有${c.group.ageGroup.seniors}位老人`);
  if (c.group.ageGroup.youngChildren > 0)
    step("👶", `有${c.group.ageGroup.youngChildren}名幼儿`);

  console.log();
  const ok = await ask("  ✅ 差不多吗？(y/n) [y]: ");
  if (ok.toLowerCase() === "n") {
    console.log("  🔄 重新来...\n");
    return await round1_parseIntent({ stage: "intent_parsing", errors: [] });
  }

  return state;
}

// ─── Round 2: 追问 ───────────────────────────────────

async function round2_followUp(state: PlanningState): Promise<PlanningState> {
  state = await stage2_followUp(state);

  const questions = state.followUpQuestions;
  if (!questions || questions.length === 0) return state;

  stage("💬 Round 2: 确认几个细节");

  const answers: FollowUpAnswer[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log(`\n    ❓ ${q.question}`);
    console.log(`       (${q.reason})`);

    for (let j = 0; j < q.options.length; j++) {
      const opt = q.options[j];
      const marker = j === 0 ? "★" : " ";
      console.log(`        ${marker} ${opt.label} — ${opt.hint}`);
    }

    console.log(`        0) 跳过`);

    const choice = await ask("    选择 (1/2/3/0): ");
    const num = parseInt(choice, 10);

    if (num >= 1 && num <= q.options.length) {
      const selected = q.options[num - 1];
      answers.push({
        questionId: q.id,
        selectedValues: [selected.value],
        patches: buildPatches(q, selected.value),
      });
      step("", `已选: ${selected.label}`);
    } else {
      step("", `跳过`);
    }
  }

  if (answers.length > 0) {
    state = await stage2_followUp(state, answers);
  }

  state.followUpQuestions = [];
  return state;
}

function buildPatches(
  q: FollowUpQuestion,
  value: string
): Partial<FollowUpAnswer["patches"]> {
  if (q.id === "elderly_dietary") {
    return { dietaryRestrictions: value === "none" ? [] : value === "soft" ? ["软食", "轻油盐"] : ["轻油盐"] };
  }
  if (q.id === "dieting_level") {
    if (value === "strict") return { dietaryRestrictions: ["低卡", "轻食"] };
    if (value === "cheat_day") return { dietaryRestrictions: [] };
  }
  if (q.id === "budget") {
    return { budget: value as "low" | "medium" | "high" };
  }
  return {};
}

// ─── Round 3: 展示方案 + 微调 ─────────────────────────

async function round3_showAndTune(state: PlanningState): Promise<PlanningState> {
  stage("🔍 Round 3: 正在搜索和编排...");

  state = await stage3_generateCandidates(state);
  state = await stage4_feasibilityCheck(state);
  state = await stage5_selectBest(state, {
    weightOverride: activeProfile ? resolveWeights(activeProfile) : undefined,
  });

  if (!state.selectedPlan) {
    error("没能找到合适的方案");
    if (state.errors.length > 0) {
      for (const e of state.errors) warn(e);
    }

    const retry = await ask("\n  🔄 调整要求重试？(y/n): ");
    if (retry.toLowerCase() === "y") {
      const hint = await ask("  💡 补充啥信息: ");
      const newState = await stage1_parseIntent(
        { stage: "intent_parsing", errors: [] },
        hint,
              );
      return await round3_showAndTune(newState);
    }
    return state;
  }

  const plan = state.selectedPlan;
  showPlanDetail(plan);

  // M2 帕累托多方案对比
  if (state.decision && state.decision.pareto.length > 1) {
    console.log(`\n  🧭 多目标方案对比:`);
    for (const cand of state.decision.pareto) {
      const tag = ObjectiveLabel[cand.objective ?? "balanced"];
      const tot = cand.plan.score?.total ?? cand.feasibilityScore;
      const star = cand.plan.id === plan.id ? "★" : " ";
      console.log(`     ${star} [${tag}] ${tot}分 — ${cand.plan.summary}`);
    }

    const whyNot = state.decision.recommended.plan.explanation?.whyNotOthers ?? [];
    if (whyNot.length > 0) {
      console.log(`\n  💡 为何首推这套:`);
      for (const w of whyNot) console.log(`     · ${w}`);
    }

    if (state.decision.notes.length > 0) {
      console.log(`\n  🛟 决策过程:`);
      for (const n of state.decision.notes) console.log(`     · ${n}`);
    }
  }

  // 微调选项
  console.log(`\n  🛠️  需要调整吗？`);
  console.log(`     1) 就这样，没问题`);
  console.log(`     2) 换个景点`);
  console.log(`     3) 换家餐厅`);
  console.log(`     4) 重新描述需求`);
  console.log(`     0) 取消`);

  const choice = await ask("    选择: ");
  if (choice === "2") {
    const hint = await ask("    想玩什么类型的？: ");
    const newState = { ...state };
    newState.constraints = { ...state.constraints!, extraHints: [...state.constraints!.extraHints, hint] };
    newState.candidates = [];
    newState.selectedPlan = undefined;
    return await round3_showAndTune(newState);
  }
  if (choice === "3") {
    const hint = await ask("    想吃什么类型的？: ");
    const newState = { ...state };
    newState.constraints = { ...state.constraints!, extraHints: [...state.constraints!.extraHints, hint] };
    newState.candidates = [];
    newState.selectedPlan = undefined;
    return await round3_showAndTune(newState);
  }
  if (choice === "4") {
    return await round1_parseIntent({ stage: "intent_parsing", errors: [] });
  }
  if (choice === "0") {
    error("已取消");
    return state;
  }

  return state;
}

// ─── Round 4: 输出最终决策方案（不下单） ─────────────

async function round4_decision(state: PlanningState): Promise<void> {
  if (!state.selectedPlan) return;

  stage("🧠 Round 4: 一键决策完成");

  const plan = state.selectedPlan;
  const firstTime = plan.activities[0]?.scheduledStart ?? "14:00";
  const firstPlace = plan.activities[0]?.place.name ?? "首站";

  console.log();
  console.log(`  ✅ 已为你决策出最优方案（${plan.feasibilityScore}分）`);
  console.log(`     ${plan.summary}`);
  console.log(`     总时长 ${plan.totalDurationHours}h | 通勤 ${plan.totalTransitMinutes}min`);
  console.log();

  console.log(`  🗒️  可直接照此安排，预订/购票请在对应平台自行操作：`);
  for (const line of showPlanBriefly(plan)) {
    console.log(line);
  }

  console.log(`\n  📱 可分享文案:`);
  console.log(
    `     "决策好了，${firstTime}出发，先去${firstPlace}，路线已排好~"`
  );
  console.log();
  console.log(`  ${D}`);
  console.log("  🎉 决策完成！需要换方案或调整偏好，随时再来~");
  console.log(`  ${D}\n`);
}

// ─── 主流程 ──────────────────────────────────────────

async function selectProfile(): Promise<void> {
  console.log("  🧑 选一个画像（个性化决策权重），直接回车=均衡型:");
  ALL_SEGMENTS.forEach((seg, i) => {
    const sp = getSegmentProfile(seg);
    console.log(`     ${i + 1}) ${sp.label} — ${sp.description}`);
  });
  const choice = await ask("    选择: ");
  const idx = parseInt(choice, 10) - 1;
  if (idx >= 0 && idx < ALL_SEGMENTS.length) {
    activeProfile = createProfile({ id: "demo_user", segment: ALL_SEGMENTS[idx] });
    step("", `已选画像: ${getSegmentProfile(ALL_SEGMENTS[idx]).label}`);
  }
  console.log();
}

async function main() {
  header();
  console.log("  💡 怎么开心怎么来，我先听听你的想法~");
  console.log(`  ${D}`);
  console.log();

  await selectProfile();

  let state: PlanningState = { stage: "intent_parsing", errors: [] };

  // Round 1
  state = await round1_parseIntent(state);

  // Round 2
  state = await round2_followUp(state);

  // Round 3
  state = await round3_showAndTune(state);

  if (!state.selectedPlan) {
    console.log("\n  👋 下次再聊！");
    rl.close();
    return;
  }

  // Round 4
  await round4_decision(state);

  rl.close();
}

main().catch((err) => {
  console.error("Demo error:", err);
  rl.close();
});
