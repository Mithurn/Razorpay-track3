import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export function openRouterModel(apiKey: string, modelId: string): LanguageModel {
  return createOpenRouter({ apiKey })(modelId);
}
