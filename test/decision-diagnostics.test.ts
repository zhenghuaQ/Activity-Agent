import { describe, expect, it } from "vitest";
import { DECISION_SCENARIOS } from "../eval/decision/scenarios/cases.js";
import { runDecisionQualityProbes } from "../eval/diagnostics/probes.js";
import { buildDecisionQualityAudit, renderDecisionQualityMarkdown } from "../eval/diagnostics/report.js";

describe("Decision Quality Diagnostic Audit", () => {
  it("runs deterministic runtime probes without modifying the fixed benchmark", async () => {
    const benchmarkBefore = JSON.stringify(DECISION_SCENARIOS);
    const result = await runDecisionQualityProbes();
    const benchmarkAfter = JSON.stringify(DECISION_SCENARIOS);
    expect(benchmarkAfter).toBe(benchmarkBefore);
    expect(result.probes.length).toBeGreaterThanOrEqual(10);
    expect(result.audits.dietaryCompatibility).toMatchObject({ canonicalSeafood: true, canonicalNonSpicy: true, genericBooleanIgnored: true });
    expect(result.probes.find(probe => probe.id === "preferred-distance")?.runs[0]?.constraints?.distance.preferredMaxKm).toBe(3);
    expect(result.audits.distancePreference).toMatchObject({ searchUsed: false, candidateSetIdentical: true, hardFeasibleBoth: true, hardViolationRejected: true });
    expect(result.audits.recommendationPreference).toMatchObject({
      evaluatorVersion: "decision-evaluator-v1.0",
      selectionSource: "execution.selectedPlan",
      alternativeMetricRetained: false,
    });
    expect((result.audits.distancePreference as { preferred3: { selectedIdentity: string; nearPreferenceScore: number; farPreferenceScore: number } }).preferred3).toMatchObject({
      nearPreferenceScore: expect.any(Number), farPreferenceScore: expect.any(Number),
    });
    const distancePreference = result.audits.distancePreference as { preferred3: { selectedIdentity: string }; nearIdentity: string };
    expect(distancePreference.preferred3.selectedIdentity).toBe(distancePreference.nearIdentity);
    expect(result.probes.find(probe => probe.id === "preference-correction")?.runs[0]?.constraints?.group.preferences.preferredCuisine).toEqual(["火锅"]);
    expect(result.tieBreak.changed.candidates).toBe(false);
    expect(result.tieBreak.changed.score).toBe(false);
    expect(result.tieBreak.changed.selectedPlan).toBe(false);
    expect(result.tieBreak.changed.pareto).toBe(false);
  }, 120_000);

  it("generates audit with exact one-defect recommendation and copyable reports", async () => {
    const result = await runDecisionQualityProbes();
    const audit = buildDecisionQualityAudit(result);
    const markdown = renderDecisionQualityMarkdown(audit);
    expect(audit.productionLogicModified).toBe(false);
    expect(audit.benchmarkVersion).toBe("decision-v3.1");
    expect(audit.recommendation.defectId).toBe("none");
    expect(audit.defects.some(defect => defect.id === "DQ-05")).toBe(false);
    expect(audit.defects.some(defect => defect.id === "DQ-08")).toBe(false);
    expect(audit.defects.some(defect => defect.id === "DQ-02")).toBe(false);
    expect(audit.defects.some(defect => defect.id === "DQ-06")).toBe(false);
    expect(audit.defects.some(defect => defect.id === "DQ-01")).toBe(false);
    expect(audit.defects.some(defect => defect.id === "DQ-11")).toBe(false);
    expect(audit.defects.some(defect => defect.id === "DQ-04")).toBe(false);
    expect(audit.audits.groupSuitability).toMatchObject({ searchUsed: false, candidateIdsIdentical: true, hardFeasibleBoth: true, selectedPlanChanged: true, groupContextOnlyChanged: true });
    expect(audit.defects.some(defect => defect.id === "DQ-09")).toBe(false);
    expect(audit.defects.some(defect => defect.id === "DQ-10")).toBe(false);
    expect(audit.defects.some(defect => defect.id === "DQ-07")).toBe(true);
    expect(audit.audits.decisionTrace).toMatchObject({ version: "decision-trace-v1", candidateCount: 3, scoredCount: 2, rejectedNotScored: true });
    expect(Object.values(audit.audits.explanationFidelity as Record<string, unknown>).every(value => value === true)).toBe(true);
    expect(audit.audits.dietaryCompatibility).toMatchObject({
      canonicalSeafood: true,
      canonicalNonSpicy: true,
      seafoodExpectedId: "diag-seafood-lower-supported",
      nonSpicyExpectedId: "diag-spicy-lower-supported",
      genericOnlyRuntimeCompleted: true,
      genericOnlyTermination: "no_feasible_plan",
      genericOnlyHasUnknownEvidence: true,
      conjunctionPassesOnlyWithBoth: true,
      conjunctionRejectsPartial: true,
      genericBooleanIgnored: true,
    });
    expect(audit.defects.some(defect => defect.id === "DQ-03")).toBe(true);
    const temporalProbe = audit.audits.planSchema as Record<string, unknown>;
    expect(temporalProbe.planningTermination).toBe("no_feasible_plan");
    expect(temporalProbe.runtimeCompleted).toBe(true);
    expect(audit.defects.every(defect => defect.codeEvidence.length > 0 && defect.runtimeEvidence.length > 0)).toBe(true);
    expect(markdown).toContain("Constraint influence matrix");
    expect(markdown).toContain("Recommendation / scope status");
    expect(markdown).toContain("SEARCH_HINT_AND_SOFT_RANKING");
    expect(markdown).not.toContain("LLM Judge result");
  }, 120_000);
});
