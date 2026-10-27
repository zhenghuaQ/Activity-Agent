import { randomUUID } from "node:crypto";
import { runMultiturnSimulation, type ChatCompletionMessage } from "openevals";
import type { DecisionScenarioExecutionInput } from "../decision/scenarios/schema.js";
import type { DecisionScenarioRunOutput } from "../decision/evaluators/conversation.js";
import { createOpenEvalsApp, OpenEvalsRuntimeFailure, type OpenEvalsAppAdapter } from "./app-adapter.js";
import { scenarioScriptedResponses } from "./scripted-user.js";
import { convertOpenEvalsTrajectory } from "./trajectory.js";
import type { OpenEvalsScenarioRun } from "./types.js";

function failedOutput(scenario: DecisionScenarioExecutionInput, error: unknown): DecisionScenarioRunOutput {
  const message = error instanceof Error ? error.message : String(error);
  return {
    scenarioId: scenario.id,
    turnSnapshots: [],
    runtime: {
      completed: false,
      durationMs: 0,
      toolCalls: 0,
      replans: 0,
      errors: [message],
    },
  };
}

/** Runs one fixed Scenario using OpenEvals' official static-response multiturn harness. */
export async function runScenarioOpenEvals(
  scenario: DecisionScenarioExecutionInput,
  memoryEnabled = true,
  executionId: string = randomUUID(),
  createAppAdapter: typeof createOpenEvalsApp = createOpenEvalsApp,
): Promise<OpenEvalsScenarioRun> {
  const threadId = `${scenario.id}:${executionId}`;
  const adapter: OpenEvalsAppAdapter = createAppAdapter(scenario, memoryEnabled);
  const started = performance.now();
  let simulatorTrajectory: ChatCompletionMessage[] = [];
  let execution: DecisionScenarioRunOutput | undefined;
  try {
    const result = await runMultiturnSimulation({
      app: adapter.app,
      user: scenarioScriptedResponses(scenario),
      maxTurns: scenario.turns.length,
      threadId,
    });
    simulatorTrajectory = result.trajectory;
    execution = adapter.getExecution(threadId);
    if (!execution) throw new Error("openevals_runtime_session_missing");
  } catch (error) {
    execution = error instanceof OpenEvalsRuntimeFailure
      ? error.execution
      : adapter.getExecution(threadId) ?? failedOutput(scenario, error);
    execution.runtime.completed = false;
    const message = error instanceof Error ? error.message : String(error);
    if (!execution.runtime.errors.includes(message)) execution.runtime.errors.push(message);
  } finally {
    adapter.disposeAll();
  }

  const simulationDurationMs = Math.round(performance.now() - started);
  const trajectory = convertOpenEvalsTrajectory(simulatorTrajectory, execution!, simulationDurationMs);
  return { threadId, trajectory, execution: execution! };
}
