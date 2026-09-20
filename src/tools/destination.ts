import type * as T from "../../spec/tools.js";
import { RESOLVE_DESTINATION_TOOL } from "../../spec/tools.js";
import { BaseTool, type ToolExecutionContext } from "./base.js";
import { getDataProvider } from "../data/index.js";
import { rethrowProviderError } from "./provider-errors.js";

export class ResolveDestinationTool extends BaseTool<T.ResolveDestinationInput, T.ResolveDestinationOutput> {
  name = "resolve_destination";
  description = RESOLVE_DESTINATION_TOOL.description;
  inputSchema = RESOLVE_DESTINATION_TOOL.inputSchema;

  protected async run(input: T.ResolveDestinationInput, context?: ToolExecutionContext): Promise<T.ResolveDestinationOutput> {
    try {
      return await getDataProvider().resolveDestination(input.destination, { signal: context?.signal });
    } catch (error) {
      rethrowProviderError(error);
    }
  }
}
