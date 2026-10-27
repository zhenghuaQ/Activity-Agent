import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DECISION_SCENARIOS } from "../decision/scenarios/cases.js";
import { DECISION_BENCHMARK_VERSION } from "../decision/scenarios/schema.js";
import { validateDecisionScenarios } from "../decision/scenarios/validate.js";
import { evaluateDecisionScenario } from "../decision/evaluators/conversation.js";
import { runScenarioOpenEvals } from "../openevals/scripted-runner.js";
import { hashDecisionScenario } from "../langsmith/dataset.js";
import { buildJudgeDecisionContext, buildJudgeReferenceContext } from "../judge/context.js";
import { DECISION_ARTIFACT_SCHEMA_VERSION, type DecisionEvaluationArtifact, type DecisionEvaluationArtifactScenario } from "./schema.js";
import { DECISION_EVALUATOR_VERSION } from "../decision/evaluator-version.js";
import { decisionTraceInvariantViolations } from "../../src/decision/trace.js";

export function safeGitProvenance(cwd = process.cwd()): Pick<DecisionEvaluationArtifact["provenance"], "gitCommit" | "gitDirty"> {
  let gitCommit: string | undefined;
  let gitDirty = true;
  try {
    gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch { /* Git metadata is optional provenance. */ }
  try {
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    gitDirty = Boolean(status);
  } catch { /* Unknown/non-repository checkouts are marked dirty rather than clean. */ }
  return { ...(gitCommit ? { gitCommit } : {}), gitDirty };
}

export function artifactId(commit?: string): string {
  return commit ? `${commit.slice(0, 8)}-${randomUUID().slice(0, 6)}` : `local-${randomUUID().slice(0, 8)}`;
}

export function createArtifactScenario(
  scenario: (typeof DECISION_SCENARIOS)[number],
  execution: Awaited<ReturnType<typeof runScenarioOpenEvals>>["execution"],
  deterministic: ReturnType<typeof evaluateDecisionScenario>,
): DecisionEvaluationArtifactScenario {
  if (execution.decisionTrace && decisionTraceInvariantViolations(execution.decisionTrace).length > 0) {
    throw new Error(`invalid_decision_trace:${scenario.id}`);
  }
  const decision = buildJudgeDecisionContext(execution);
  return {
    scenarioId: scenario.id,
    scenarioHash: hashDecisionScenario(scenario),
    reference: buildJudgeReferenceContext(scenario),
    conversation: {
      userTurns: scenario.turns.map(turn => turn.user),
      assistantMessages: execution.turnSnapshots.map(turn => turn.userVisibleMessage ?? ""),
    },
    decision,
    ...(execution.decisionTrace ? { decisionTrace: structuredClone(execution.decisionTrace) } : {}),
    deterministic: {
      outcome: deterministic.outcome,
      taskSuccess: deterministic.taskSuccess,
      runtimeCompleted: deterministic.runtimeCompleted,
      planGenerated: deterministic.planGenerated,
      hardConstraintResult: {
        checks: deterministic.hardConstraintChecks,
        violations: deterministic.hardConstraintViolations,
        passed: deterministic.hardConstraintsPassed,
      },
      adaptationResult: {
        checks: deterministic.adaptationChecks,
        errors: deterministic.adaptationErrors,
        passed: deterministic.adaptationErrors === 0,
      },
      preferenceResult: {
        checks: deterministic.preferenceChecks,
        matches: deterministic.preferenceMatches,
        passed: deterministic.preferenceApplicable && deterministic.preferenceMatches === deterministic.preferenceChecks,
      },
      recommendationPreferenceResult: {
        applicable: deterministic.preferenceApplicable,
        satisfied: deterministic.preferenceMatches,
        total: deterministic.preferenceChecks,
        coverage: deterministic.preferenceCoverage,
        details: deterministic.preferenceDetails,
        ...(deterministic.preferenceNotApplicableReason ? { notApplicableReason: deterministic.preferenceNotApplicableReason } : {}),
      },
    },
  };
}

export async function generateDecisionEvaluationArtifact(options: {
  variantLabel?: string;
  outputPath?: string;
  cwd?: string;
  runScenario?: typeof runScenarioOpenEvals;
} = {}): Promise<{ artifact: DecisionEvaluationArtifact; filePath: string }> {
  const scenarios = validateDecisionScenarios(DECISION_SCENARIOS);
  const provenance = safeGitProvenance(options.cwd);
  const id = artifactId(provenance.gitCommit);
  const rows: DecisionEvaluationArtifactScenario[] = [];
  for (const scenario of scenarios) {
    // Deliberately construct the execution input from agent-visible fields only.
    const executionInput = {
      id: scenario.id,
      description: scenario.description,
      domain: scenario.domain,
      turns: structuredClone(scenario.turns),
      environment: structuredClone(scenario.environment),
      tags: [...scenario.tags],
    };
    const { execution } = await (options.runScenario ?? runScenarioOpenEvals)(executionInput, true, randomUUID());
    const deterministic = evaluateDecisionScenario(scenario, execution, true);
    rows.push(createArtifactScenario(scenario, execution, deterministic));
  }
  const artifact: DecisionEvaluationArtifact = {
    schemaVersion: DECISION_ARTIFACT_SCHEMA_VERSION,
    benchmarkVersion: DECISION_BENCHMARK_VERSION,
    evaluatorVersion: DECISION_EVALUATOR_VERSION,
    provenance: {
      artifactId: id,
      ...provenance,
      createdAt: new Date().toISOString(),
      runner: "openevals-scripted",
      nodeVersion: process.version,
      ...(options.variantLabel?.trim() ? { variantLabel: options.variantLabel.trim() } : {}),
    },
    scenarios: rows,
  };
  const directory = path.resolve(options.outputPath ?? "eval-results/decision-artifacts");
  await fs.mkdir(directory, { recursive: true });
  const timestamp = artifact.provenance.createdAt.replaceAll(":", "-");
  const filename = `${DECISION_BENCHMARK_VERSION}-${id}-${timestamp}.json`;
  const filePath = path.join(directory, filename);
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), "utf8");
  return { artifact, filePath };
}

export function hashArtifactContent(artifact: DecisionEvaluationArtifact): string {
  return createHash("sha256").update(JSON.stringify(artifact), "utf8").digest("hex");
}
