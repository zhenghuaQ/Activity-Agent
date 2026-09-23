// Generic place search Tool. Legacy category-specific tools remain compatibility wrappers.

import type * as T from "../../spec/tools.js";
import { validateSearchSpatial } from "../../spec/place-search.js";
import { SEARCH_PLACES_TOOL } from "../../spec/tools.js";
import { BaseTool, ok, type ToolExecutionContext } from "./base.js";
import type { ToolOutput } from "../../spec/tool-response.js";
import { ToolError } from "./errors.js";
import type { ActivityDataProviderV1 } from "../../spec/datasource.js";
import { createDefaultDataProvider } from "../data/index.js";
import { rethrowProviderError } from "./provider-errors.js";

export class SearchPlacesTool extends BaseTool<
  T.SearchPlacesInput,
  T.SearchPlacesOutput
> {
  constructor(private readonly provider: ActivityDataProviderV1 = createDefaultDataProvider()) {
    super();
  }

  name = "search_places";
  description = SEARCH_PLACES_TOOL.description;
  inputSchema = SEARCH_PLACES_TOOL.inputSchema;

  protected async run(
    input: T.SearchPlacesInput,
    context?: ToolExecutionContext,
  ): Promise<ToolOutput<T.SearchPlacesOutput>> {
    const invalid = validateSearchSpatial(input.spatial);
    if (invalid) throw new ToolError("E_PARAM_INVALID", invalid);
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
      throw new ToolError("E_PARAM_INVALID", "limit must be a positive integer");
    }

    try {
      const result = await this.provider.searchPlaces(input, { signal: context?.signal });
      return ok(
        `地点搜索完成，共 ${result.places.length} 个候选（${result.total} 个匹配）`,
        result,
        { source: "generic_place_search" },
      );
    } catch (error) {
      rethrowProviderError(error);
    }
  }
}
