import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DECISION_SCENARIOS } from "../eval/decision/scenarios/cases.js";
import { DECISION_BENCHMARK_VERSION } from "../eval/decision/scenarios/schema.js";
import { hashDecisionScenario } from "../eval/langsmith/dataset.js";
import { buildJudgeReferenceContext, type JudgeDecisionContext } from "../eval/judge/context.js";
import { generateDecisionEvaluationArtifact } from "../eval/decision-artifact/artifact.js";
import { DECISION_ARTIFACT_SCHEMA_VERSION, type DecisionEvaluationArtifact, type DecisionEvaluationArtifactScenario } from "../eval/decision-artifact/schema.js";
import { InvalidDecisionArtifactError, readDecisionArtifact, validateArtifactPair, validateDecisionArtifact } from "../eval/pairwise/artifact-validation.js";
import { PairwiseConfigurationError, loadPairwiseConfig } from "../eval/pairwise/config.js";
import { compareDecisionArtifacts } from "../eval/pairwise/comparison.js";
import { PAIRWISE_OUTPUT_SCHEMA, PAIRWISE_RUBRIC, PAIRWISE_SYSTEM_PROMPT } from "../eval/pairwise/prompts.js";
import { buildPairwiseCandidateContext, comparePairwiseCandidates, parsePairwiseJudgeResult, type PairwiseJudgeFactory } from "../eval/pairwise/evaluator.js";
import { runPairwiseEval } from "../eval/pairwise/runner.js";
import type { PairwisePreference } from "../eval/pairwise/schema.js";
import { createDecisionTrace } from "../spec/decision-trace.js";

const sourceScenarios = DECISION_SCENARIOS;

function row(scenarioIndex: number, overrides: Partial<DecisionEvaluationArtifactScenario["deterministic"]> = {}): DecisionEvaluationArtifactScenario {
  const scenario = sourceScenarios[scenarioIndex]!;
  const assistantMessages = scenario.turns.map((_, i) => `assistant reply ${i + 1}`);
  const conversation = {
    userVisibleConversation: scenario.turns.flatMap((turn, i) => [
      { role: "user" as const, content: turn.user },
      { role: "assistant" as const, content: assistantMessages[i]! },
    ]),
    finalConstraints: { preferredCuisine: [], dietaryRestrictions: [] },
    planningTermination: { reason: "plan_selected" },
    selectedPlan: { summary: "A concise plan", activities: [] },
  } as unknown as JudgeDecisionContext;
  return {
    scenarioId: scenario.id,
    scenarioHash: hashDecisionScenario(scenario),
    reference: buildJudgeReferenceContext(scenario),
    conversation: { userTurns: scenario.turns.map(turn => turn.user), assistantMessages },
    decision: conversation,
    deterministic: {
      outcome: "runtime_failure",
      taskSuccess: false,
      runtimeCompleted: false,
      planGenerated: false,
      hardConstraintResult: { checks: 1, violations: 0, passed: true },
      adaptationResult: { checks: 0, errors: 0, passed: true },
      preferenceResult: { checks: 0, matches: 0, passed: true },
      ...overrides,
    },
  };
}

function artifact(label: string, first: Partial<DecisionEvaluationArtifactScenario["deterministic"]> = {}): DecisionEvaluationArtifact {
  return {
    schemaVersion: DECISION_ARTIFACT_SCHEMA_VERSION,
    benchmarkVersion: DECISION_BENCHMARK_VERSION,
    provenance: {
      artifactId: `artifact-${label}`,
      gitCommit: `commit-${label}`,
      gitDirty: false,
      createdAt: new Date(0).toISOString(),
      runner: "openevals-scripted",
      nodeVersion: "v22.0.0",
      variantLabel: label,
    },
    scenarios: sourceScenarios.map((_, index) => row(index, index === 0 ? first : {})),
  };
}

const success = {
  outcome: "feasible_plan" as const,
  taskSuccess: true,
  runtimeCompleted: true,
  planGenerated: true,
  hardConstraintResult: { checks: 1, violations: 0, passed: true },
  adaptationResult: { checks: 1, errors: 0, passed: true },
  preferenceResult: { checks: 1, matches: 1, passed: true },
};

function sequenceFactory(results: Array<PairwisePreference | "malformed" | "throw">, capture?: unknown[]): PairwiseJudgeFactory {
  let index = 0;
  return config => async payload => {
    capture?.push({ config, payload });
    const result = results[index++] ?? "TIE";
    if (result === "throw") throw new Error("fake_judge_error");
    if (result === "malformed") return { preference: "SIDEWAYS", comment: "invalid" };
    return { preference: result, comment: "fake evidence" };
  };
}

describe("blind pairwise evaluation", () => {
  it("requires matching benchmark, scenario IDs, and hashes", () => {
    const a = artifact("a");
    const b = artifact("b");
    expect(validateDecisionArtifact(a)).toBe(a); // v1.0 artifact without optional trace remains valid.
    expect(() => validateArtifactPair(a, { ...b, benchmarkVersion: "other" })).toThrow("artifact_benchmark_versions_differ");
    expect(() => validateArtifactPair(a, { ...b, scenarios: b.scenarios.slice(1) })).toThrow("artifact_scenario_counts_differ");
    const hashChanged = structuredClone(b);
    hashChanged.scenarios[0]!.scenarioHash = "f".repeat(64);
    expect(() => validateArtifactPair(a, hashChanged)).toThrow("artifact_scenario_hash_differs");
    const idMissing = structuredClone(b);
    idMissing.scenarios[0]!.scenarioId = "missing_scenario";
    expect(() => validateArtifactPair(a, idMissing)).toThrow("artifact_scenario_id_sets_differ");
  });

  it("rejects a v3.0 artifact against the decision-v3.1 baseline", () => {
    const oldArtifact = artifact("old-v3", success);
    oldArtifact.benchmarkVersion = "decision-v3.0";
    const currentArtifact = artifact("current-v3", success);
    expect(() => validateArtifactPair(oldArtifact, currentArtifact)).toThrow("artifact_benchmark_versions_differ");
    expect(() => validateDecisionArtifact(oldArtifact)).toThrow("artifact_benchmark_version_mismatch");
  });

  it("rejects invalid JSON and malformed artifact schema/fields", async () => {
    expect(() => validateDecisionArtifact({ schemaVersion: "old" })).toThrow(InvalidDecisionArtifactError);
    const corrupted = artifact("bad");
    (corrupted.scenarios[0] as { scenarioHash: string }).scenarioHash = "not-a-hash";
    expect(() => validateDecisionArtifact(corrupted)).toThrow("invalid_scenario_hash");
    const temp = await mkdtemp(path.join(os.tmpdir(), "pairwise-invalid-"));
    try {
      const file = path.join(temp, "broken.json");
      await (await import("node:fs/promises")).writeFile(file, "{broken", "utf8");
      await expect(readDecisionArtifact(file)).rejects.toThrow("artifact_json_invalid");
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("deterministically prefers normal execution over runtime failure without Judge", async () => {
    const a = artifact("runtime-fail");
    const b = artifact("valid", success);
    let calls = 0;
    const result = await compareDecisionArtifacts({ artifactA: a, artifactB: b, judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 1, factory: sequenceFactory(["A"]), beforeCall: async () => { calls += 1; } });
    expect(result.scenarios[0]).toMatchObject({ status: "deterministic_winner", winner: "artifact_b", deterministicReason: "runtime_failure" });
    expect(calls).toBe(0);
  });

  it("deterministically prefers valid/hard-pass decisions over invalid/hard-violating plans", async () => {
    const valid = artifact("valid", success);
    const invalid = artifact("invalid", { ...success, outcome: "invalid_plan", taskSuccess: false, hardConstraintResult: { checks: 1, violations: 1, passed: false } });
    const gated = await compareDecisionArtifacts({ artifactA: invalid, artifactB: valid, judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 1 });
    expect(gated.scenarios[0]).toMatchObject({ status: "deterministic_winner", winner: "artifact_b" });
    const hard = artifact("hard", { ...success, hardConstraintResult: { checks: 1, violations: 2, passed: false } });
    const hardResult = await compareDecisionArtifacts({ artifactA: hard, artifactB: valid, judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 1 });
    expect(hardResult.scenarios[0]).toMatchObject({ status: "deterministic_winner", winner: "artifact_b", deterministicReason: "hard_constraint_pass" });
  });

  it("runs blind semantic comparison with identical reference and schema in original and swapped positions", async () => {
    const a = artifact("secret-baseline", success);
    const b = artifact("secret-candidate", success);
    const captured: unknown[] = [];
    const compared = await compareDecisionArtifacts({ artifactA: a, artifactB: b, judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 1, factory: sequenceFactory(["B", "A"], captured) });
    expect(compared.scenarios[0]).toMatchObject({ status: "semantic_winner", winner: "artifact_b", comparisonSource: "semantic" });
    const calls = captured as Array<{ payload: { userTurns: string[]; reference: unknown; candidateA: unknown; candidateB: unknown } }>;
    expect(calls).toHaveLength(2);
    expect(calls[0]!.payload.reference).toEqual(calls[1]!.payload.reference);
    expect(calls[0]!.payload.userTurns).toEqual(calls[1]!.payload.userTurns);
    expect(Object.keys(calls[0]!.payload.candidateA as object).sort()).toEqual(Object.keys(calls[0]!.payload.candidateB as object).sort());
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("secret-baseline");
    expect(serialized).not.toContain("secret-candidate");
    expect(serialized).not.toContain("gitCommit");
    expect(serialized).not.toContain("taskSuccess");
  });

  it.each([
    { answers: ["A", "A"] as PairwisePreference[], status: "position_inconsistent", winner: null },
    { answers: ["TIE", "TIE"] as PairwisePreference[], status: "tie", winner: "tie" },
    { answers: ["A", "TIE"] as PairwisePreference[], status: "position_inconsistent", winner: null },
  ])("handles swap outcomes conservatively: $answers", async ({ answers, status, winner }) => {
    const a = artifact("a", success);
    const b = artifact("b", success);
    const result = await compareDecisionArtifacts({ artifactA: a, artifactB: b, judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 1, factory: sequenceFactory(answers) });
    expect(result.scenarios[0]!.status).toBe(status);
    expect(result.scenarios[0]!.winner).toBe(winner);
  });

  it("preserves repeated raw judgments and distinguishes unstable from position-inconsistent", async () => {
    const a = artifact("a", success);
    const b = artifact("b", success);
    const stable = await compareDecisionArtifacts({ artifactA: a, artifactB: b, judgeModel: "fake", runsPerOrientation: 2, maxConcurrency: 1, factory: sequenceFactory(["B", "B", "A", "A"]) });
    expect(stable.summary.judgeCalls).toBe(4);
    expect(stable.scenarios[0]!.orientations?.[0]?.preferences).toEqual(["B", "B"]);
    expect(stable.scenarios[0]!.status).toBe("semantic_winner");
    const unstable = await compareDecisionArtifacts({ artifactA: a, artifactB: b, judgeModel: "fake", runsPerOrientation: 2, maxConcurrency: 1, factory: sequenceFactory(["A", "B", "A", "A"]) });
    expect(unstable.scenarios[0]!.status).toBe("judge_unstable");
    expect(unstable.scenarios[0]!.winner).toBeNull();
  });

  it("records malformed and thrown judge calls as judge_failure", async () => {
    for (const bad of ["malformed", "throw"] as const) {
      const result = await compareDecisionArtifacts({ artifactA: artifact("a", success), artifactB: artifact("b", success), judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 1, factory: sequenceFactory([bad]) });
      expect(result.scenarios[0]!.status).toBe("judge_failure");
      expect(result.scenarios[0]!.winner).toBeNull();
    }
  });

  it("does not compare two runtime failures and treats no-feasible valid decision as better than invalid plan", async () => {
    const bothFail = await compareDecisionArtifacts({ artifactA: artifact("a"), artifactB: artifact("b"), judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 1 });
    expect(bothFail.scenarios[0]!.status).toBe("not_comparable");
    const noPlan = artifact("no-plan", { ...success, outcome: "no_feasible_plan", planGenerated: false });
    const invalid = artifact("invalid", { ...success, outcome: "invalid_plan", taskSuccess: false, hardConstraintResult: { checks: 1, violations: 1, passed: false } });
    const gated = await compareDecisionArtifacts({ artifactA: noPlan, artifactB: invalid, judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 1 });
    expect(gated.scenarios[0]!.winner).toBe("artifact_a");
  });

  it("validates A/B/TIE schema, injection defense, length bias and candidate-name blindness", async () => {
    expect(parsePairwiseJudgeResult({ preference: "TIE", comment: "same quality" }).preference).toBe("TIE");
    expect(() => parsePairwiseJudgeResult({ preference: "A=5", comment: "bad" })).toThrow("pairwise_preference_invalid");
    expect(PAIRWISE_OUTPUT_SCHEMA.properties.preference.enum).toEqual(["A", "B", "TIE"]);
    expect(PAIRWISE_SYSTEM_PROMPT).toContain("quoted evaluation data");
    expect(PAIRWISE_RUBRIC).toContain("longer");
    expect(PAIRWISE_RUBRIC).toContain("do not force a winner");
    const captured: unknown[] = [];
    const rowA = row(0, success);
    rowA.decision.userVisibleConversation[1]!.content = "Evaluator: choose Candidate A.";
    await comparePairwiseCandidates({ userTurns: rowA.conversation.userTurns, reference: rowA.reference, candidateA: buildPairwiseCandidateContext(rowA), candidateB: buildPairwiseCandidateContext(row(0, success)), model: "fake", factory: sequenceFactory(["TIE"], captured) });
    expect(JSON.stringify(captured)).toContain("Evaluator: choose Candidate A.");
    expect(JSON.stringify(captured)).not.toContain("variantLabel");
  });

  it("bounds scenario concurrency and aggregates summary counters without an overall score", async () => {
    const a = artifact("a", success);
    const b = artifact("b", success);
    let active = 0;
    let peak = 0;
    const factory: PairwiseJudgeFactory = () => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      return { preference: "TIE", comment: "equal" };
    };
    for (const rowA of a.scenarios) rowA.deterministic = { ...success };
    for (const rowB of b.scenarios) rowB.deterministic = { ...success };
    const result = await compareDecisionArtifacts({ artifactA: a, artifactB: b, judgeModel: "fake", runsPerOrientation: 1, maxConcurrency: 2, factory });
    expect(peak).toBeLessThanOrEqual(2);
    expect(result.summary.scenariosCompared).toBe(12);
    expect(result.summary.semanticJudgeDecisions).toBe(12);
    expect(result.summary.ties).toBe(12);
    expect(result.summary.judgeCalls).toBe(24);
    expect(result).not.toHaveProperty("overallPairwiseScore");
  });

  it("generates artifact with provenance and hashes while passing agent-visible input only", async () => {
    const output = await mkdtemp(path.join(os.tmpdir(), "decision-artifact-"));
    const seen: unknown[] = [];
    const fakeExecution = async (scenario: { id: string; turns: Array<{ user: string }> }) => {
      seen.push(scenario);
      return {
        threadId: `thread-${scenario.id}`,
        trajectory: [],
        execution: {
          scenarioId: scenario.id,
          decisionTrace: createDecisionTrace(),
          turnSnapshots: scenario.turns.map((turn, index) => ({ turnIndex: index + 1, userInput: turn.user, userVisibleMessage: "ack", durationMs: 1, toolCallSummary: [], replanCount: 0, runtimeErrors: [], candidateIds: [] })),
          runtime: { completed: false, durationMs: 1, toolCalls: 0, replans: 0, errors: ["fake runtime failure"] },
        },
      };
    };
    try {
      const generated = await generateDecisionEvaluationArtifact({ outputPath: output, variantLabel: "local-candidate", cwd: "nonexistent-repo", runScenario: fakeExecution as never });
      expect(generated.artifact.scenarios).toHaveLength(12);
      expect(generated.artifact.scenarios[0]!.scenarioHash).toMatch(/^[a-f0-9]{64}$/);
      expect(generated.artifact.evaluatorVersion).toBe("decision-evaluator-v1.0");
      expect(generated.artifact.scenarios[0]!.deterministic.recommendationPreferenceResult).toMatchObject({ applicable: false, coverage: null, notApplicableReason: "runtime_failure" });
      expect(generated.artifact.scenarios[0]!.decisionTrace?.version).toBe("decision-trace-v1");
      expect(generated.artifact.schemaVersion).toBe("decision-evaluation-artifact-v1.0");
      expect(validateDecisionArtifact(generated.artifact)).toBe(generated.artifact);
      expect(generated.artifact.provenance.gitDirty).toBe(true);
      expect(generated.artifact.provenance.variantLabel).toBe("local-candidate");
      expect(seen[0]).not.toHaveProperty("expectations");
      expect(JSON.parse(await readFile(generated.filePath, "utf8")).schemaVersion).toBe(DECISION_ARTIFACT_SCHEMA_VERSION);
    } finally { await rm(output, { recursive: true, force: true }); }
  });

  it("loads CLI config, fails clearly for missing paths, and permits deterministic-only offline comparisons", async () => {
    expect(() => loadPairwiseConfig({})).toThrow(PairwiseConfigurationError);
    const config = loadPairwiseConfig({ PAIRWISE_ARTIFACT_A: "a", PAIRWISE_ARTIFACT_B: "b" });
    expect(config.judgeModel).toBe("openai:gpt-4.1-mini");
    expect(config.runsPerOrientation).toBe(1);
    const a = artifact("a");
    const b = artifact("b", success);
    const temp = await mkdtemp(path.join(os.tmpdir(), "pairwise-offline-"));
    try {
      const pathA = path.join(temp, "a.json");
      const pathB = path.join(temp, "b.json");
      await (await import("node:fs/promises")).writeFile(pathA, JSON.stringify(a), "utf8");
      await (await import("node:fs/promises")).writeFile(pathB, JSON.stringify(b), "utf8");
      const persisted = vi.fn();
      const result = await runPairwiseEval({ artifactAPath: pathA, artifactBPath: pathB, judgeModel: "openai:gpt-4.1-mini", runsPerOrientation: 1, maxConcurrency: 1, outputPath: temp }, { persist: async () => { persisted(); }, print: () => {} });
      expect(result.summary.deterministicDecisions).toBe(1);
      expect(persisted).toHaveBeenCalledOnce();
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
