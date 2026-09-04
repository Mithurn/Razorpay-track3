import { randomUUID } from "node:crypto";
import type { NewCase } from "../src/domain/ports.js";
import type { RecoveryAction } from "../src/domain/recovery-action.js";
import type { CustomerPayment } from "../src/domain/case.js";
import type { RootCause } from "../src/domain/failure.js";

// The synthetic failure stream. Error reasons are Razorpay's own; the ground truth says which
// action recovers each case and when, or that it is genuinely lost. selfRecovers marks the
// customers who would have paid on their own — contacting them is the false-positive cost.
// trueCause is the actual reason behind the decline, graded separately from the action taken.

export type RecoveryFamily = "RETRY" | "PAYMENT_LINK" | "CUSTOMER_NUDGE";

export type GroundTruth = {
  recoverable: boolean;
  via: RecoveryFamily | null;
  atHour: number | null;
  selfRecovers: boolean;
  trueCause: RootCause;
  note: string;
};

export type CorpusCase = NewCase & { id: string; groundTruth: GroundTruth };

export type CorpusOptions = {
  runId: string | null;
  size?: number;
  seed?: number;
  downFraction?: number;
  /**
   * Overwrite every case's failureCode/failureReason with one generic value, leaving ground
   * truth untouched. `rules-arm.ts` switches on that exact string, and in this corpus it is
   * close to the answer key — 7 templates, one `failureReason` each. Blinding it removes the
   * one input the rules table needs and everything else keeps working from: customer history,
   * the downtime feed, similar-case outcomes, prior attempts. Isolates what diagnosis is
   * actually worth from what a templated corpus' label happens to give away for free.
   */
  blindReason?: boolean;
};

const BLINDED_CODE = "PAYMENT_FAILED";
const BLINDED_REASON = "payment_failed_generic";

// A small deterministic PRNG so a run is reproducible and the numbers are defensible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ISSUERS_UP = ["HDFC", "ICIC", "SBIN", "AXIS", "KKBK"];
const ISSUERS_DOWN = ["BKID", "PUNB", "CNRB", "CITI"];

// `drift` stretches the payment cadence and raises the failure rate over the record — a lapsing
// account's real signature, readable only from the tool output, not the error reason or a count.
function history(rng: () => number, count: number, base: number, opts: { failRate?: number; drift?: number } = {}): CustomerPayment[] {
  const failRate = opts.failRate ?? 0.12;
  const drift = opts.drift ?? 0;
  const out: CustomerPayment[] = [];
  let t = Date.parse("2026-02-01T00:00:00.000Z");
  for (let i = 0; i < count; i++) {
    t += (25 + Math.floor(rng() * 10) + Math.round(drift * i * 3)) * 86_400_000;
    out.push({
      paidAt: new Date(t).toISOString(),
      amountPaise: base,
      method: "card",
      status: rng() < failRate + drift * 0.03 * i ? "failed" : "captured",
    });
  }
  return out;
}

type Template = {
  reason: string;
  code: string;
  method: string;
  build: (rng: () => number) => {
    instrument: Record<string, string> | null;
    gt: GroundTruth;
    historyCount: number;
    historyOpts?: { failRate?: number; drift?: number };
  };
};

const TEMPLATES: Template[] = [
  {
    reason: "insufficient_funds",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_UP[0]! },
      gt: { recoverable: true, via: "RETRY", atHour: 72, selfRecovers: false, trueCause: "insufficient_funds", note: "funds arrive by day 3" },
      historyCount: 6,
      historyOpts: { failRate: 0.04, drift: 0 },
    }),
  },
  {
    reason: "card_declined",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: (rng) => ({
      instrument: { issuer: ISSUERS_UP[Math.floor(rng() * ISSUERS_UP.length)]! },
      gt: { recoverable: true, via: "RETRY", atHour: 8, selfRecovers: rng() < 0.5, trueCause: "soft_decline", note: "soft decline, clears on one retry" },
      historyCount: 4,
    }),
  },
  {
    reason: "card_expired",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    // A real card network sometimes auto-updates an expired card (issuer account-updater
    // services) before the merchant ever contacts the customer — genuinely unknowable in
    // advance, same as a self-recovering soft decline. Nudging one is not wrong, just wasted:
    // the false-positive cost the over-nudge rate exists to measure. Without this, every
    // CUSTOMER_NUDGE case has selfRecovers: false by construction and the metric can only read
    // 0.0%, which is not a measured number, it is a property of the corpus.
    build: (rng) => ({
      instrument: { issuer: ISSUERS_UP[1]! },
      gt: { recoverable: true, via: "CUSTOMER_NUDGE", atHour: 24, selfRecovers: rng() < 0.2, trueCause: "hard_decline", note: "needs a new card" },
      historyCount: 6,
    }),
  },
  {
    reason: "issuer_technical_error",
    code: "GATEWAY_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_DOWN[0]! },
      gt: { recoverable: true, via: "RETRY", atHour: 12, selfRecovers: false, trueCause: "bank_downtime", note: "issuer downtime, clears within the window" },
      historyCount: 5,
    }),
  },
  {
    reason: "payment_failed",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: (rng) => ({
      instrument: { issuer: ISSUERS_UP[Math.floor(rng() * ISSUERS_UP.length)]! },
      gt: { recoverable: true, via: "PAYMENT_LINK", atHour: 6, selfRecovers: false, trueCause: "technical", note: "original rail stuck, another rail works" },
      historyCount: 3,
    }),
  },
  {
    reason: "payment_risk_check_failed",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_UP[2]! },
      gt: { recoverable: false, via: null, atHour: null, selfRecovers: false, trueCause: "risk_hold", note: "risk hold, must go to a human" },
      historyCount: 2,
    }),
  },
  {
    reason: "insufficient_funds",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_UP[3]! },
      gt: { recoverable: false, via: null, atHour: null, selfRecovers: false, trueCause: "unrecoverable", note: "account never funds, genuinely lost" },
      historyCount: 4,
      // Same reason as the case above, opposite truth — the trend, not the count, tells them apart.
      historyOpts: { failRate: 0.32, drift: 1.6 },
    }),
  },
];

// Every 5th generic-decline case (card_declined/payment_failed) is a live downtime match instead
// — a stated 20% share, not a coincidental modulo. Must stay odd: the two reasons alternate, so
// an even rate would only ever land on one of them.
const GENERIC_DECLINE_REASONS = new Set(["card_declined", "payment_failed"]);
const DOWNTIME_PAIR_RATE = 5;

export function generateCorpus(opts: CorpusOptions): CorpusCase[] {
  const rng = mulberry32(opts.seed ?? 42);
  const size = opts.size ?? 120;
  const cases: CorpusCase[] = [];
  let genericDeclineOccurrence = 0;

  for (let i = 0; i < size; i++) {
    const template = TEMPLATES[i % TEMPLATES.length]!;
    const built = template.build(rng);
    // ₹6,499 is over safety-gate.ts's DEFAULT_LIMITS.maxExposurePaise (₹5,000) — the same figure
    // the live demo's cust_over_cap uses. Without it, the exposure cap is proven only by a unit
    // test and the demo's one seeded case, never by the measured batch.
    const AMOUNTS = [49900, 99900, 149900, 249900, 649900];
    const base = AMOUNTS[Math.floor(rng() * AMOUNTS.length)]!;

    let isDownPair = false;
    if (GENERIC_DECLINE_REASONS.has(template.reason)) {
      genericDeclineOccurrence++;
      isDownPair = genericDeclineOccurrence % DOWNTIME_PAIR_RATE === 0;
    }
    const instrument = isDownPair ? { issuer: ISSUERS_DOWN[genericDeclineOccurrence % ISSUERS_DOWN.length]! } : built.instrument;
    const gt: GroundTruth = isDownPair
      ? {
          recoverable: true,
          via: "RETRY",
          atHour: 14,
          selfRecovers: false,
          trueCause: "bank_downtime",
          note: "issuer in a live downtime window, not a customer- or card-side problem",
        }
      : built.gt;

    const id = randomUUID();
    cases.push({
      id,
      runId: opts.runId,
      merchantRef: "acme_subscriptions",
      customerRef: `cust_${1000 + i}`,
      originalPaymentId: null,
      amountPaise: base,
      currency: "INR",
      failureCode: opts.blindReason ? BLINDED_CODE : template.code,
      failureReason: opts.blindReason ? BLINDED_REASON : template.reason,
      failedAt: new Date(Date.parse("2026-09-01T06:00:00.000Z") + i * 3_600_000).toISOString(),
      method: template.method,
      instrument,
      customerHistory: history(rng, built.historyCount, base, built.historyOpts),
      groundTruth: gt,
    });
  }
  return cases;
}
