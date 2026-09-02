import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export type ModelKeys = {
  openRouterApiKey?: string;
  googleApiKey?: string;
};

// Model id syntax picks the provider: "google/<id>" uses the AI Studio key directly (the
// first-party adapter round-trips Gemini's thought signatures); anything else goes through
// OpenRouter. The id is always an env override.
export function resolveModel(modelId: string, keys: ModelKeys): LanguageModel {
  if (modelId.startsWith("google/")) {
    if (!keys.googleApiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is required for a google/ model");
    return createGoogleGenerativeAI({ apiKey: keys.googleApiKey })(modelId.slice("google/".length));
  }
  if (!keys.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is required for a non-google model");
  return createOpenRouter({ apiKey: keys.openRouterApiKey })(modelId);
}
