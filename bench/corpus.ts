import { randomUUID } from "node:crypto";
import type { NewCase } from "../src/domain/ports.js";
import type { RecoveryAction } from "../src/domain/recovery-action.js";
import type { CustomerPayment } from "../src/domain/case.js";

// The synthetic failure stream. Error reasons are Razorpay's own; the ground truth says which
// action recovers each case and when, or that it is genuinely lost. selfRecovers marks the
// customers who would have paid on their own — contacting them is the false-positive cost.

export type RecoveryFamily = "RETRY" | "PAYMENT_LINK" | "CUSTOMER_NUDGE";

export type GroundTruth = {
  recoverable: boolean;
  via: RecoveryFamily | null;
  atHour: number | null;
  selfRecovers: boolean;
  note: string;
};

export type CorpusCase = NewCase & { id: string; groundTruth: GroundTruth };

export type CorpusOptions = {
  runId: string;
  size?: number;
  seed?: number;
  downFraction?: number;
};

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

function history(rng: () => number, count: number, base: number): CustomerPayment[] {
  const out: CustomerPayment[] = [];
  let t = Date.parse("2026-02-01T00:00:00.000Z");
  for (let i = 0; i < count; i++) {
    t += (25 + Math.floor(rng() * 10)) * 86_400_000;
    out.push({
      paidAt: new Date(t).toISOString(),
      amountPaise: base,
      method: "card",
      status: rng() < 0.12 ? "failed" : "captured",
    });
  }
  return out;
}

type Template = {
  reason: string;
  code: string;
  method: string;
  build: (rng: () => number) => { instrument: Record<string, string> | null; gt: GroundTruth; historyCount: number };
};

const TEMPLATES: Template[] = [
  {
    reason: "insufficient_funds",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_UP[0]! },
      gt: { recoverable: true, via: "RETRY", atHour: 72, selfRecovers: false, note: "funds arrive by day 3" },
      historyCount: 5,
    }),
  },
  {
    reason: "card_declined",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: (rng) => ({
      instrument: { issuer: ISSUERS_UP[Math.floor(rng() * ISSUERS_UP.length)]! },
      gt: { recoverable: true, via: "RETRY", atHour: 8, selfRecovers: rng() < 0.5, note: "soft decline, clears on one retry" },
      historyCount: 4,
    }),
  },
  {
    reason: "card_expired",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_UP[1]! },
      gt: { recoverable: true, via: "CUSTOMER_NUDGE", atHour: 24, selfRecovers: false, note: "needs a new card" },
      historyCount: 6,
    }),
  },
  {
    reason: "issuer_technical_error",
    code: "GATEWAY_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_DOWN[0]! },
      gt: { recoverable: true, via: "RETRY", atHour: 12, selfRecovers: false, note: "issuer downtime, clears within the window" },
      historyCount: 5,
    }),
  },
  {
    reason: "payment_failed",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: (rng) => ({
      instrument: { issuer: ISSUERS_UP[Math.floor(rng() * ISSUERS_UP.length)]! },
      gt: { recoverable: true, via: "PAYMENT_LINK", atHour: 6, selfRecovers: false, note: "original rail stuck, another rail works" },
      historyCount: 3,
    }),
  },
  {
    reason: "payment_risk_check_failed",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_UP[2]! },
      gt: { recoverable: false, via: null, atHour: null, selfRecovers: false, note: "risk hold, must go to a human" },
      historyCount: 2,
    }),
  },
  {
    reason: "insufficient_funds",
    code: "BAD_REQUEST_ERROR",
    method: "card",
    build: () => ({
      instrument: { issuer: ISSUERS_UP[3]! },
      gt: { recoverable: false, via: null, atHour: null, selfRecovers: false, note: "account never funds, genuinely lost" },
      historyCount: 1,
    }),
  },
];

export function generateCorpus(opts: CorpusOptions): CorpusCase[] {
  const rng = mulberry32(opts.seed ?? 42);
  const size = opts.size ?? 120;
  const cases: CorpusCase[] = [];

  for (let i = 0; i < size; i++) {
    const template = TEMPLATES[i % TEMPLATES.length]!;
    const built = template.build(rng);
    const base = [49900, 99900, 149900, 249900][Math.floor(rng() * 4)]!;

    // Matched pair: every ~8th case is a generic decline whose issuer IS in a downtime window,
    // so the recovery is "wait for the bank" not "nudge the customer" — the fixed schedule
    // cannot tell it apart from its neighbour.
    const isDownPair = template.reason === "payment_failed" && i % 8 === 0;
    const instrument = isDownPair ? { issuer: ISSUERS_DOWN[i % ISSUERS_DOWN.length]! } : built.instrument;
    const gt: GroundTruth = isDownPair
      ? { recoverable: true, via: "RETRY", atHour: 14, selfRecovers: false, note: "issuer in a live downtime window" }
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
      failureCode: template.code,
      failureReason: template.reason,
      failedAt: new Date(Date.parse("2026-09-01T06:00:00.000Z") + i * 3_600_000).toISOString(),
      method: template.method,
      instrument,
      customerHistory: history(rng, built.historyCount, base),
      groundTruth: gt,
    });
  }
  return cases;
}
