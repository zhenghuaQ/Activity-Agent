import { AgentRuntime, createAgentInput } from "../src/runtime/index.js";
import { parseIntent } from "../src/intent/parser.js";
import type { PlanResult } from "../src/planner/engine.js";
import type { StructuredConstraints } from "../spec/types.js";
import type { ConversationEvalCase, MemoryExpectation } from "./conversation-cases.js";

export interface ConversationEvalResult {
  caseName: string;
  memoryEnabled: boolean;
  taskSuccess: boolean;
  memoryChecks: number;
  memoryErrors: number;
  hardConstraintChecks: number;
  hardConstraintViolations: number;
  preferenceChecks: number;
  preferenceMatches: number;
  durationMs: number;
  toolCalls: number;
  turns: number;
  errors: string[];
}

function includesAll(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return expected.every(value => actual?.includes(value));
}
function checkMemory(constraints: StructuredConstraints, expected: MemoryExpectation): { checks: number; errors: string[] } {
  const checks: [boolean, string][] = [];
  if (expected.destinationCity) checks.push([constraints.destination?.city === expected.destinationCity, "destinationCity"]);
  if (expected.leadRole) checks.push([constraints.group.leadRole === expected.leadRole, "leadRole"]);
  if (expected.budget) checks.push([constraints.group.preferences.budget === expected.budget, "budget"]);
  if (expected.preferredCuisine) checks.push([includesAll(constraints.group.preferences.preferredCuisine, expected.preferredCuisine)
    && (constraints.group.preferences.preferredCuisine?.length ?? 0) === expected.preferredCuisine.length, "preferredCuisine"]);
  if (expected.dietaryRestrictions) checks.push([includesAll(constraints.group.preferences.dietaryRestrictions, expected.dietaryRestrictions), "dietaryRestrictions"]);
  if (expected.extraHints) checks.push([includesAll(constraints.extraHints, expected.extraHints), "extraHints"]);
  return { checks: checks.length, errors: checks.filter(([passed]) => !passed).map(([, name]) => name) };
}

export async function runConversationCase(testCase: ConversationEvalCase, memoryEnabled: boolean): Promise<ConversationEvalResult> {
  const runtime = new AgentRuntime(); const started = performance.now(); let memory: StructuredConstraints | undefined;
  let memoryChecks = 0; let memoryErrors = 0; let toolCalls = 0; let final: PlanResult | undefined; const errors: string[] = [];
  try {
    for (const [index, turn] of testCase.turns.entries()) {
      const submission = await runtime.submit(createAgentInput(turn.user, { parseFn: parseIntent,
        ...(memoryEnabled && memory ? { baseConstraints: memory } : {}) }), { sessionId: `eval_${memoryEnabled ? "memory" : "stateless"}_${testCase.name}` });
      if (!submission.result || typeof submission.result !== "object") throw new Error(submission.error ?? "missing_result");
      final = submission.result as PlanResult; memory = final.state.constraints; toolCalls += final.agentState.toolCalls.length;
      if (!memory) { errors.push(`turn_${index + 1}:missing_memory`); continue; }
      const checked = checkMemory(memory, turn.expectedMemory); memoryChecks += checked.checks;
      memoryErrors += checked.errors.length; errors.push(...checked.errors.map(name => `turn_${index + 1}:memory:${name}`));
    }
    const plan = final?.state.selectedPlan; const decision = final?.state.decision;
    const taskSuccess = Boolean(final?.success && plan && decision && decision.pareto.length > 0);
    let hardConstraintChecks = 0; let hardConstraintViolations = 0;
    const hard = testCase.hardConstraints;
    if (hard?.destinationCity) {
      hardConstraintChecks++; if (!plan || plan.activities.some(activity => activity.place.location.city !== hard.destinationCity)) {
        hardConstraintViolations++; errors.push("hard:destinationCity");
      }
    }
    if (hard?.maxDistanceKm) {
      hardConstraintChecks++; if (!plan || plan.activities.some(activity => activity.place.distanceKm > hard.maxDistanceKm!)) {
        hardConstraintViolations++; errors.push("hard:maxDistanceKm");
      }
    }
    if (hard?.dietaryRestrictions?.length) {
      hardConstraintChecks++; const restaurant = plan?.activities.find(activity => activity.place.type === "restaurant");
      if (!restaurant || !("dietaryOptions" in restaurant.place) || restaurant.place.dietaryOptions !== true) {
        hardConstraintViolations++; errors.push("hard:dietaryRestrictions");
      }
    }
    let preferenceChecks = 0; let preferenceMatches = 0;
    const preferredCuisine = memory?.group.preferences.preferredCuisine ?? [];
    if (preferredCuisine.length) {
      preferenceChecks++;
      const offeredPlans = decision?.pareto.map(candidate => candidate.plan) ?? (plan ? [plan] : []);
      const covered = offeredPlans.some(offered => {
        const restaurant = offered.activities.find(activity => activity.place.type === "restaurant");
        const cuisine = restaurant && "cuisine" in restaurant.place && typeof restaurant.place.cuisine === "string"
          ? restaurant.place.cuisine : undefined;
        return Boolean(cuisine && preferredCuisine.some(preferred => cuisine.includes(preferred)));
      });
      if (covered) preferenceMatches++;
    }
    return { caseName: testCase.name, memoryEnabled, taskSuccess, memoryChecks, memoryErrors,
      hardConstraintChecks, hardConstraintViolations, preferenceChecks, preferenceMatches,
      durationMs: Math.round(performance.now() - started),
      toolCalls, turns: testCase.turns.length, errors };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { caseName: testCase.name, memoryEnabled, taskSuccess: false, memoryChecks, memoryErrors,
      hardConstraintChecks: 0, hardConstraintViolations: 0, preferenceChecks: 0, preferenceMatches: 0,
      durationMs: Math.round(performance.now() - started),
      toolCalls, turns: testCase.turns.length, errors };
  } finally { runtime.shutdown(); }
}
