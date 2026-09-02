import type { RecoveryCase } from "../domain/case.js";
import type { Attempt, Clock } from "../domain/attempt.js";
import type { PaymentGateway } from "../domain/gateway.js";
import type { AgentDeps, SimilarCaseSummary } from "../agent/tools.js";

// Razorpay names the instrument differently per rail (issuer / bank / vpa_handle); the case
// carries whichever applies. This is what lets the agent line a card decline up against a
// downtime on that exact issuer.
export function instrumentHint(kase: RecoveryCase): string | null {
  if (!kase.instrument) return null;
  return kase.instrument.issuer ?? kase.instrument.bank ?? kase.instrument.vpa_handle ?? null;
}

export type BuildDeps = {
  gateway: Pick<PaymentGateway, "listDowntimes">;
  clock: Clock;
  similarCases?: (kase: RecoveryCase) => Promise<SimilarCaseSummary[]>;
};

export async function buildAgentDeps(
  kase: RecoveryCase,
  priorAttempts: Attempt[],
  deps: BuildDeps,
): Promise<AgentDeps> {
  return {
    kase,
    method: kase.method ?? kase.customerHistory.at(-1)?.method ?? "card",
    instrumentHint: instrumentHint(kase),
    gateway: deps.gateway,
    priorAttempts,
    similarCases: () => (deps.similarCases ? deps.similarCases(kase) : Promise.resolve([])),
    clock: deps.clock,
  };
}
