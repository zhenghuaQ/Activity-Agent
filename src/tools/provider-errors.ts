import { isDataProviderError } from "../data/provider-error.js";
import { ToolError } from "./errors.js";

export function rethrowProviderError(error: unknown): never {
  if (isDataProviderError(error)) {
    if (error.code === "destination_unsupported" || error.code === "capability_unsupported") {
      throw new ToolError("E_DESTINATION_UNSUPPORTED", error.message);
    }
    if (error.code === "rate_limited") throw new ToolError("E_RATE_LIMITED", error.message);
    if (error.code === "network_unavailable") throw new ToolError("E_NETWORK_UNAVAILABLE", error.message);
    if (error.code === "authentication_failed") throw new ToolError("E_STATE_CONFLICT", error.message);
    throw new ToolError("E_EXECUTION_FAILED", error.message);
  }
  throw error;
}
