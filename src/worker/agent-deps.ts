import type { RecoveryCase } from "../domain/case.js";
import type { Attempt, Clock } from "../domain/attempt.js";
import type { PaymentGateway } from "../domain/gateway.js";
import type { SimilarCaseSummary } from "../domain/ports.js";
import type { AgentDeps, SimilarCasesQuery } from "../agent/tools.js";

export function instrumentHint(kase: RecoveryCase): string | null {
  if (!kase.instrument) return null;
  return kase.instrument.issuer ?? kase.instrument.bank ?? kase.instrument.vpa_handle ?? null;
}

export type BuildDeps = {
  gateway: Pick<PaymentGateway, "listDowntimes">;
  clock: Clock;
  similarCases?: (kase: RecoveryCase, query: SimilarCasesQuery) => Promise<SimilarCaseSummary[]>;
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
    similarCases: (query) => (deps.similarCases ? deps.similarCases(kase, query) : Promise.resolve([])),
    clock: deps.clock,
  };
}
