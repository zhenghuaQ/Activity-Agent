import { AgentRuntime } from "../../../src/runtime/index.js";
import type { ActivityDataProviderV1 } from "../../../spec/datasource.js";
import { MockProvider } from "../../../src/data/providers/mock-provider.js";
import { createToolRegistry } from "../../../src/tools/registry.js";
import { FixtureLocationResolver } from "../../shared/location.js";
import type { DecisionScenario } from "./schema.js";

export interface ScenarioRuntime {
  runtime: AgentRuntime;
  dataProvider: ActivityDataProviderV1;
  locationResolver: FixtureLocationResolver;
}

export function createScenarioRuntime(scenario: DecisionScenario): ScenarioRuntime {
  const dataProvider = new MockProvider(structuredClone(scenario.environment.data));
  const locationResolver = new FixtureLocationResolver(structuredClone(scenario.environment.location));
  const runtime = new AgentRuntime({
    toolRegistry: createToolRegistry({ dataProvider, locationResolver }),
  });
  return { runtime, dataProvider, locationResolver };
}
