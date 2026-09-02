// A hard ceiling on paid model usage. Wraps a LanguageModel and throws once the estimated spend
// crosses the cap, so a runaway loop or a large batch cannot quietly run up a bill. Free-tier
// models cost nothing here; the cap still bounds call count as a backstop.

import type { LanguageModel } from "ai";

export type BudgetState = { calls: number; estUsd: number; capUsd: number; costPerCallUsd: number };

// Conservative: ~4k input + ~500 output per call on gemini-2.5-flash ($0.30 / $2.50 per M).
// Deliberately rounded up so the cap trips early rather than late.
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
