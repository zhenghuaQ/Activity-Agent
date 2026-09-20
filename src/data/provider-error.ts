import type { DataProviderErrorCode } from "../../spec/datasource.js";

export class DataProviderError extends Error {
  constructor(
    readonly code: DataProviderErrorCode,
    message: string,
    readonly providerId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DataProviderError";
  }
}

export function isDataProviderError(error: unknown): error is DataProviderError {
  return error instanceof DataProviderError;
}
