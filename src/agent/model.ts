import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export type ModelKeys = {
  openRouterApiKey?: string;
  googleApiKey?: string;
};

export type ModelProvider = "google" | "openrouter";

// "google/<id>" uses the AI Studio key directly; anything else goes through OpenRouter.
export function splitModelId(modelId: string): { provider: ModelProvider; id: string } {
  return modelId.startsWith("google/")
    ? { provider: "google", id: modelId.slice("google/".length) }
    : { provider: "openrouter", id: modelId };
}

export function resolveModel(modelId: string, keys: ModelKeys): LanguageModel {
  const { provider, id } = splitModelId(modelId);
  if (provider === "google") {
    if (!keys.googleApiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is required for a google/ model");
    return createGoogleGenerativeAI({ apiKey: keys.googleApiKey })(id);
  }
  if (!keys.openRouterApiKey) throw new Error("OPENROUTER_API_KEY is required for a non-google model");
  return createOpenRouter({ apiKey: keys.openRouterApiKey })(id);
}
