import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export function openRouterModel(apiKey: string | undefined, modelId: string): LanguageModel {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required to run the agent");
  return createOpenRouter({ apiKey })(modelId);
}
