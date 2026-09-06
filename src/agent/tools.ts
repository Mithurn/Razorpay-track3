import { z } from "zod";
import { tool } from "ai";
import type { RecoveryCase } from "../domain/case.js";
import type { Attempt, Clock } from "../domain/attempt.js";
import type { Downtime, PaymentGateway } from "../domain/gateway.js";
import type { SimilarCaseSummary } from "../domain/ports.js";

export type SimilarCasesQuery = { method?: string | null; limit?: number };

export type AgentDeps = {
  kase: RecoveryCase;
  method: string;
  instrumentHint: string | null;
  gateway: Pick<PaymentGateway, "listDowntimes">;
  priorAttempts: Attempt[];
  similarCases: (query: SimilarCasesQuery) => Promise<SimilarCaseSummary[]>;
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

function describeDowntime(d: Downtime) {
  return { id: d.id, method: d.method, severity: d.severity, instrument: d.instrument, startedAt: d.begin };
}

// Data, not prose in the system prompt — the model must call get_recovery_playbook to see it.
// Timing is deliberately absent: get_customer_payment_history already exposes the customer's own
// cadence (medianDaysBetweenPayments, daysSinceLastSuccess) and check_bank_downtime exposes when
// a window opened — the playbook naming an hour count would just be handing back the corpus's own
// ground truth as advice. Judge the delay from those tools, not from a number here.
const PLAYBOOK: { rootCause: string; defaultAction: string; note: string }[] = [
  {
    rootCause: "soft_decline",
    defaultAction: "RETRY_SCHEDULED",
    note: "Clean-history customer, generic decline, no downtime — a recoverable payment. Time the retry from the customer's own payment cadence.",
  },
  {
    rootCause: "insufficient_funds",
    defaultAction: "RETRY_SCHEDULED",
    note: "Time it toward when the customer historically has money — read that from their payment history, not a fixed guess.",
  },
  {
    rootCause: "bank_downtime",
    defaultAction: "RETRY_SCHEDULED",
    note: "Time it to when the downtime feed shows the window clearing. Never a nudge — the customer did nothing wrong.",
  },
  {
    rootCause: "hard_decline",
    defaultAction: "CUSTOMER_NUDGE",
    note: "Card expired. A retry is pointless; the customer must act. If the merchant's record shows links on another rail recovering these, use PAYMENT_LINK instead.",
  },
  {
    rootCause: "technical",
    defaultAction: "RETRY_NOW",
    note: "Transient technical failure. Use RETRY_SCHEDULED instead if a downtime window is open, or PAYMENT_LINK if the merchant's record shows the original rail stuck but another rail recovering these.",
  },
  {
    rootCause: "risk_hold",
    defaultAction: "ESCALATE",
    note: "Risk-flagged or fraud-shaped pattern. Never auto-retry.",
  },
  {
    rootCause: "unrecoverable",
    defaultAction: "WRITE_OFF",
    note: "Thin or failing history, an account that never funds, a decline that will not clear.",
  },
];

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
        "Razorpay's live payment-downtime feed, checked against the specific issuing bank or VPA " +
        "behind this failure. `matched` is true only when that exact instrument is degraded right " +
        "now — real evidence the bank caused this decline, not the customer or the card. " +
        "`methodWideOutages` lists any other active outage on the same payment method, on a " +
        "different bank — background context, not evidence about this specific customer.",
      inputSchema: z.object({}),
      execute: async () => {
        const active = (await deps.gateway.listDowntimes()).filter((d) => d.status === "started");
        const issuerMatch = active.filter((d) => matchesInstrument(d, deps.instrumentHint));
        const methodWideOutages = active.filter(
          (d) => d.method === deps.method && !matchesInstrument(d, deps.instrumentHint),
        );
        return {
          method: deps.method,
          instrument: deps.instrumentHint,
          matched: issuerMatch.length > 0,
          activeDowntimes: issuerMatch.map(describeDowntime),
          methodWideOutages: methodWideOutages.map(describeDowntime),
        };
      },
    }),

    get_recovery_playbook: tool({
      description:
        "The merchant's default recovery move for each root cause — a starting point, not a " +
        "verdict. Call this once you have a root-cause hypothesis, then decide whether the " +
        "specific evidence you've gathered (history, downtime, similar cases, prior attempts) " +
        "gives you a reason to deviate from it. State that reason if you do.",
      inputSchema: z.object({}),
      execute: async () => ({ playbook: PLAYBOOK }),
    }),

    get_similar_resolved_cases: tool({
      description:
        "How past cases with this same error reason actually ended: the action taken, whether it " +
        "recovered the money, and how long that took. Narrow with method to one rail, or raise " +
        "limit for more history, based on what you still need to decide.",
      inputSchema: z.object({
        method: z.string().optional().describe("Filter to one payment rail, e.g. 'card' or 'netbanking'"),
        limit: z.number().int().min(1).max(20).optional().describe("How many attempt records to pull (default 8)"),
      }),
      execute: async (input) => ({
        failureReason: deps.kase.failureReason,
        cases: await deps.similarCases(input),
      }),
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
