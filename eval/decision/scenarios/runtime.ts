import { AgentRuntime } from "../../../src/runtime/index.js";
import type { ActivityDataProviderV1 } from "../../../spec/datasource.js";
import { MockProvider } from "../../../src/data/providers/mock-provider.js";
import { createToolRegistry } from "../../../src/tools/registry.js";
import { FixtureLocationResolver } from "../../shared/location.js";
import type { DecisionScenarioExecutionInput } from "./schema.js";
import type { DecisionScenarioEnvironment } from "./schema.js";

export interface ScenarioRuntime {
  runtime: AgentRuntime;
  dataProvider: ActivityDataProviderV1;
  locationResolver: FixtureLocationResolver;
}

export function createScenarioRuntime(
  scenario: Pick<DecisionScenarioExecutionInput, "environment"> | DecisionScenarioEnvironment,
): ScenarioRuntime {
  const environment = "environment" in scenario ? scenario.environment : scenario;
  const dataProvider = new MockProvider(structuredClone(environment.data));
  const locationResolver = new FixtureLocationResolver(structuredClone(environment.location));
  const runtime = new AgentRuntime({
    toolRegistry: createToolRegistry({ dataProvider, locationResolver }),
  });
  return { runtime, dataProvider, locationResolver };
}
