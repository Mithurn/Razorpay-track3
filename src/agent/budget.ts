// A hard ceiling on paid model usage. Wraps a LanguageModel and throws once the estimated spend
// crosses the cap, so a runaway loop or a large batch cannot quietly run up a bill. Free-tier
// models cost nothing here; the cap still bounds call count as a backstop.

import type { LanguageModel } from "ai";

export type BudgetState = { calls: number; estUsd: number; capUsd: number; costPerCallUsd: number };

// Calibrated against the real measured cost, not a token estimate: a 60-case run against
// google/gemini-3.6-flash ran ~500 model calls for $1.20-1.35 (README), ~$0.0024-0.0027/call.
// $0.0025 sits inside that range rather than under it, so the cap still trips before real spend
// outruns it. Re-check against a fresh measured run before trusting this after a model or
// pricing change — gemini-3.6-flash is currently $0.75/$3.75 per M input/output tokens direct
// from AI Studio, not the OpenRouter margin this constant otherwise has no visibility into.
export function createBudget(capUsd: number, costPerCallUsd = 0.0025): BudgetState {
  return { calls: 0, estUsd: 0, capUsd, costPerCallUsd };
}

export function guardModel(model: LanguageModel, budget: BudgetState): LanguageModel {
  const bump = () => {
    budget.calls += 1;
    budget.estUsd = budget.calls * budget.costPerCallUsd;
    if (budget.estUsd > budget.capUsd) {
      throw new Error(
        `model budget cap hit: ~$${budget.estUsd.toFixed(2)} estimated over ${budget.calls} calls (cap $${budget.capUsd})`,
      );
    }
  };
  return new Proxy(model as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === "doGenerate" || prop === "doStream") && typeof value === "function") {
        return (...args: unknown[]) => {
          bump();
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LanguageModel;
}
