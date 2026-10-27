import { Client } from "langsmith/client";
import { loadLangSmithConfig, type LangSmithEvalConfig } from "./config.js";

export function createLangSmithClient(config: LangSmithEvalConfig = loadLangSmithConfig()): Client {
  return new Client({
    apiKey: config.apiKey,
    ...(config.endpoint ? { apiUrl: config.endpoint } : {}),
    ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}),
  });
}
