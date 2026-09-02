import { z } from "zod";
import { tool } from "ai";
import type { RecoveryCase } from "../domain/case.js";
import type { Attempt, Clock } from "../domain/attempt.js";
import type { Downtime, PaymentGateway } from "../domain/gateway.js";

export type SimilarCaseSummary = {
  failureReason: string;
  action: string;
  outcome: string;
  hoursToResolution: number | null;
};

export type AgentDeps = {
  kase: RecoveryCase;
  method: string;
  instrumentHint: string | null;
  gateway: Pick<PaymentGateway, "listDowntimes">;
  priorAttempts: Attempt[];
  similarCases: () => Promise<SimilarCaseSummary[]>;
  clock: Clock;
};

function summariseHistory(kase: RecoveryCase, clock: Clock) {
  const captured = kase.customerHistory.filter((p) => p.status === "captured");
  const last = captured.at(-1);
  const gapsMs = captured
    .slice(1)
    .map((p, i) => Date.parse(p.paidAt) - Date.parse(captured[i]!.paidAt))
    .filter((n) => Number.isFinite(n) && n > 0);
  return {
    totalPayments: kase.customerHistory.length,
    successfulPayments: captured.length,
    failedPayments: kase.customerHistory.filter((p) => p.status === "failed").length,
    lastSuccessfulAt: last?.paidAt ?? null,
    daysSinceLastSuccess: last ? Math.round((clock.now().getTime() - Date.parse(last.paidAt)) / 86_400_000) : null,
    methodsUsed: [...new Set(kase.customerHistory.map((p) => p.method))],
    medianDaysBetweenPayments:
      gapsMs.length > 0 ? Math.round(gapsMs.sort((a, b) => a - b)[Math.floor(gapsMs.length / 2)]! / 86_400_000) : null,
  };
}

function matchesInstrument(d: Downtime, instrumentHint: string | null): boolean {
  if (!instrumentHint) return false;
  return Object.values(d.instrument).some((v) => v.toUpperCase() === instrumentHint.toUpperCase());
}

export function buildTools(deps: AgentDeps) {
  return {
    get_customer_payment_history: tool({
      description:
        "The customer's own payment record: how many succeeded, how long since the last success, " +
        "how regularly they normally pay. Use this first to judge whether the customer is the problem.",
      inputSchema: z.object({}),
      execute: async () => summariseHistory(deps.kase, deps.clock),
    }),

    check_bank_downtime: tool({
      description:
        "Razorpay's live payment-downtime feed. Tells you whether the issuing bank or payment " +
        "method behind this failure is currently degraded. A match means the decline is likely the " +
        "bank, not the customer or the card.",
      inputSchema: z.object({}),
      execute: async () => {
        const all = await deps.gateway.listDowntimes();
        const relevant = all.filter(
          (d) =>
            d.status === "started" &&
            (d.method === deps.method || matchesInstrument(d, deps.instrumentHint)),
        );
        return {
          method: deps.method,
          instrument: deps.instrumentHint,
          activeDowntimes: relevant.map((d) => ({
            method: d.method,
            severity: d.severity,
            instrument: d.instrument,
            startedAt: d.begin,
          })),
          matched: relevant.length > 0,
        };
      },
    }),

    get_similar_resolved_cases: tool({
      description:
        "How past failures with this same error reason were resolved, and whether that worked. " +
        "Use it to check what actually recovers this kind of decline.",
      inputSchema: z.object({}),
      execute: async () => ({ failureReason: deps.kase.failureReason, cases: await deps.similarCases() }),
    }),

    get_this_case_prior_attempts: tool({
      description:
        "What has already been tried on THIS payment and how each attempt ended. Use it before " +
        "proposing another attempt so you do not repeat one that just failed.",
      inputSchema: z.object({}),
      execute: async () => ({
        attempts: deps.priorAttempts.map((a) => ({
          attemptNo: a.attemptNo,
          action: a.action,
          outcome: a.status,
          detail: a.detail,
        })),
      }),
    }),
  };
}
