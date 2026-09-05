import type { LanguageModel } from "ai";

export type BudgetState = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  // Calls whose provider response carried no usage block. Counted, never read as zero: a silent
  // zero both understates spend and disarms the cap, so these are charged at usdPerCallFallback.
  callsWithoutUsage: number;
  usdUsed: number;
  capUsd: number;
  usdPerMInput: number;
  usdPerMOutput: number;
  usdPerCallFallback: number;
};

export type Pricing = {
  usdPerMInput: number;
  usdPerMOutput: number;
  usdPerCallFallback?: number;
};

// Defaults are the Gemini API standard tier list price. They are an input to the arithmetic, not a
// measurement — tokens are measured, the rate is declared. Override per provider or after a
// pricing change; batch and cached-input tiers are cheaper and are not modelled here.
export const DEFAULT_PRICING: Required<Pricing> = {
  usdPerMInput: 1.5,
  usdPerMOutput: 7.5,
  usdPerCallFallback: 0.0025,
};

export function createBudget(capUsd: number, pricing: Pricing = DEFAULT_PRICING): BudgetState {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    callsWithoutUsage: 0,
    usdUsed: 0,
    capUsd,
    usdPerMInput: pricing.usdPerMInput,
    usdPerMOutput: pricing.usdPerMOutput,
    usdPerCallFallback: pricing.usdPerCallFallback ?? DEFAULT_PRICING.usdPerCallFallback,
  };
}

// Spec versions disagree on shape: v3/v4 nest a { total } under each side, v2 reports a bare
// number. Read both, and return undefined rather than 0 when neither is present, so "the provider
// said nothing" stays distinguishable from "the provider said zero".
function readTokens(side: unknown): number | undefined {
  if (typeof side === "number") return Number.isFinite(side) ? side : undefined;
  const total = (side as { total?: unknown } | undefined)?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : undefined;
}

function settle(b: BudgetState): void {
  b.usdUsed =
    (b.inputTokens / 1_000_000) * b.usdPerMInput +
    (b.outputTokens / 1_000_000) * b.usdPerMOutput +
    b.callsWithoutUsage * b.usdPerCallFallback;
}

function record(budget: BudgetState, usage: unknown): void {
  const u = usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
  const input = readTokens(u?.inputTokens);
  const output = readTokens(u?.outputTokens);
  if (input === undefined && output === undefined) {
    budget.callsWithoutUsage += 1;
  } else {
    budget.inputTokens += input ?? 0;
    budget.outputTokens += output ?? 0;
  }
  settle(budget);
}

// Usage on a stream only arrives with the terminal finish part, so the stream has to be metered as
// it is consumed rather than read off the call result.
function meterStream(budget: BudgetState, stream: ReadableStream<unknown>): ReadableStream<unknown> {
  return stream.pipeThrough(
    new TransformStream({
      transform(part, controller) {
        const p = part as { type?: string; usage?: unknown };
        if (p.type === "finish") record(budget, p.usage);
        controller.enqueue(part);
      },
    }),
  );
}

export function guardModel(model: LanguageModel, budget: BudgetState): LanguageModel {
  // Charged spend is only known after a call returns, so the cap is enforced on entry to the next
  // one. That still bounds the session: at most one call's worth of overshoot past the cap.
  const admit = () => {
    if (budget.usdUsed > budget.capUsd) {
      throw new Error(
        `model budget cap hit: $${budget.usdUsed.toFixed(4)} over ${budget.calls} calls ` +
          `(${budget.inputTokens} in / ${budget.outputTokens} out tokens, cap $${budget.capUsd})`,
      );
    }
    budget.calls += 1;
  };

  return new Proxy(model as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "doGenerate" && typeof value === "function") {
        return async (...args: unknown[]) => {
          admit();
          const result = (await (value as (...a: unknown[]) => unknown).apply(target, args)) as {
            usage?: unknown;
          };
          record(budget, result?.usage);
          return result;
        };
      }
      if (prop === "doStream" && typeof value === "function") {
        return async (...args: unknown[]) => {
          admit();
          const result = (await (value as (...a: unknown[]) => unknown).apply(target, args)) as {
            stream: ReadableStream<unknown>;
          };
          return { ...result, stream: meterStream(budget, result.stream) };
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as LanguageModel;
}
