import { describe, expect, it } from "vitest";
import { generateCorpus } from "../bench/corpus.js";
import { GroundTruthResolver } from "../bench/ground-truth-resolver.js";
import { fixedScheduleRunner } from "../bench/fixed-arm.js";
import { scoreArm, exceptionList, type CaseRecord } from "../bench/metrics.js";
import type { GroundTruth } from "../bench/corpus.js";

describe("corpus", () => {
  it("is deterministic for a given seed", () => {
    const a = generateCorpus({ runId: "r1", size: 30, seed: 5 });
    const b = generateCorpus({ runId: "r2", size: 30, seed: 5 });
    expect(a.map((c) => [c.failureReason, c.amountPaise, c.instrument])).toEqual(
      b.map((c) => [c.failureReason, c.amountPaise, c.instrument]),
    );
  });

  it("uses only Razorpay error reasons and carries ground truth on every case", () => {
    const allowed = new Set([
      "insufficient_funds",
      "card_declined",
      "card_expired",
      "issuer_technical_error",
      "payment_failed",
      "payment_risk_check_failed",
    ]);
    for (const c of generateCorpus({ runId: "r", size: 120, seed: 1 })) {
      expect(allowed.has(c.failureReason)).toBe(true);
      expect(c.groundTruth).toBeDefined();
      expect(typeof c.groundTruth!.recoverable).toBe("boolean");
    }
  });

  it("includes matched pairs: a generic decline whose issuer is in a downtime window", () => {
    const corpus = generateCorpus({ runId: "r", size: 120, seed: 1 });
    const downPairs = corpus.filter(
      (c) => c.failureReason === "payment_failed" && c.groundTruth!.note.includes("downtime"),
    );
    expect(downPairs.length).toBeGreaterThan(0);
    for (const c of downPairs) expect(["BKID", "PUNB", "CNRB", "CITI"]).toContain(c.instrument!.issuer);
  });

  it("marks some recoverable cases as would-self-recover (the over-nudge control)", () => {
    const corpus = generateCorpus({ runId: "r", size: 120, seed: 1 });
    expect(corpus.some((c) => c.groundTruth!.selfRecovers)).toBe(true);
  });
});

describe("GroundTruthResolver", () => {
  const epoch = Date.parse("2026-09-01T00:00:00.000Z");
  const clock = (hours: number) => ({ now: () => new Date(epoch + hours * 3_600_000) });
  const truth = new Map<string, GroundTruth>([
    ["c1", { recoverable: true, via: "RETRY", atHour: 12, selfRecovers: false, note: "downtime clears" }],
    ["c2", { recoverable: false, via: null, atHour: null, selfRecovers: false, note: "lost" }],
    ["c3", { recoverable: true, via: "CUSTOMER_NUDGE", atHour: 24, selfRecovers: false, note: "needs a new card" }],
  ]);

  it("does not recover before the ground-truth hour", async () => {
    const r = new GroundTruthResolver(truth, clock(6), epoch);
    const v = await r.resolve({ caseId: "c1", action: { kind: "RETRY_NOW" }, razorpayRef: "o", amountPaise: 1000 });
    expect(v.kind).toBe("failed");
  });

  it("recovers once the hour passes and the action family matches", async () => {
    const r = new GroundTruthResolver(truth, clock(20), epoch);
    const v = await r.resolve({
      caseId: "c1",
      action: { kind: "RETRY_SCHEDULED", atHoursFromNow: 8 },
      razorpayRef: "o",
      amountPaise: 149900,
    });
    expect(v).toEqual({ kind: "recovered", capturedPaise: 149900, paymentId: "sim_c1" });
  });

  it("never recovers the wrong action family", async () => {
    const r = new GroundTruthResolver(truth, clock(99), epoch);
    const v = await r.resolve({
      caseId: "c1",
      action: { kind: "CUSTOMER_NUDGE", channel: "email" },
      razorpayRef: null,
      amountPaise: 1000,
    });
    expect(v.kind).toBe("failed");
  });

  it("never recovers an unrecoverable case", async () => {
    const r = new GroundTruthResolver(truth, clock(999), epoch);
    const v = await r.resolve({ caseId: "c2", action: { kind: "RETRY_NOW" }, razorpayRef: "o", amountPaise: 1000 });
    expect(v.kind).toBe("failed");
  });

  it("grades a scheduled retry at the hour it is presented, not the hour it is decided", async () => {
    const r = new GroundTruthResolver(truth, clock(0), epoch);
    const v = await r.resolve({
      caseId: "c1",
      action: { kind: "RETRY_SCHEDULED", atHoursFromNow: 12 },
      razorpayRef: "o",
      amountPaise: 1000,
    });
    expect(v.kind).toBe("recovered");
    expect(r.recoveredAtHour("c1")).toBe(12);
  });

  it("fails a scheduled retry that still lands short of the hour", async () => {
    const r = new GroundTruthResolver(truth, clock(0), epoch);
    const v = await r.resolve({
      caseId: "c1",
      action: { kind: "RETRY_SCHEDULED", atHoursFromNow: 8 },
      razorpayRef: "o",
      amountPaise: 1000,
    });
    expect(v.kind).toBe("failed");
    expect(r.recoveredAtHour("c1")).toBeNull();
  });

  it("lets an outreach settle when the customer acts, not when it is sent", async () => {
    const r = new GroundTruthResolver(truth, clock(0), epoch);
    const v = await r.resolve({
      caseId: "c3",
      action: { kind: "CUSTOMER_NUDGE", channel: "email" },
      razorpayRef: null,
      amountPaise: 1000,
    });
    expect(v.kind).toBe("recovered");
    expect(r.recoveredAtHour("c3")).toBe(24);
  });

  it("settles an outreach sent after the customer's hour immediately", async () => {
    const r = new GroundTruthResolver(truth, clock(40), epoch);
    await r.resolve({
      caseId: "c3",
      action: { kind: "CUSTOMER_NUDGE", channel: "email" },
      razorpayRef: null,
      amountPaise: 1000,
    });
    expect(r.recoveredAtHour("c3")).toBe(40);
  });

  it("never leaks the recovery hour, the correct action, or the corpus note into the failure detail", async () => {
    type Probe = { hours: number; caseId: string; action: Parameters<GroundTruthResolver["resolve"]>[0]["action"] };
    const probes: Probe[] = [
      { hours: 6, caseId: "c1", action: { kind: "RETRY_NOW" } }, // too early
      { hours: 99, caseId: "c1", action: { kind: "CUSTOMER_NUDGE", channel: "email" } }, // wrong family
      { hours: 999, caseId: "c2", action: { kind: "RETRY_NOW" } }, // unrecoverable
      { hours: 999, caseId: "unknown", action: { kind: "RETRY_NOW" } }, // no ground truth
    ];
    for (const p of probes) {
      const r = new GroundTruthResolver(truth, clock(p.hours), epoch);
      const v = await r.resolve({ caseId: p.caseId, action: p.action, razorpayRef: "o", amountPaise: 1000 });
      expect(v.kind).toBe("failed");
      if (v.kind === "failed") {
        expect(v.detail).toBe("payment declined");
        expect(v.detail).not.toMatch(/\+\d+h|recovers at|wrong action|downtime clears|lost|ground truth/i);
      }
    }
  });
});

describe("fixed schedule runner", () => {
  it("retries at 24h then 48h, and never diagnoses", async () => {
    const proposal1 = await fixedScheduleRunner(
      { kase: {} as never, priorAttempts: [], method: "card", instrumentHint: null, gateway: {} as never, similarCases: async () => [], clock: { now: () => new Date() } },
      {},
    );
    expect(proposal1.action).toEqual({ kind: "RETRY_SCHEDULED", atHoursFromNow: 24 });
    expect(proposal1.diagnosisRootCause).toBeNull();

    const proposal2 = await fixedScheduleRunner(
      {
        kase: {} as never,
        priorAttempts: [{ status: "FAILED" } as never],
        method: "card",
        instrumentHint: null,
        gateway: {} as never,
        similarCases: async () => [],
        clock: { now: () => new Date() },
      },
      {},
    );
    expect(proposal2.action).toEqual({ kind: "RETRY_SCHEDULED", atHoursFromNow: 48 });
  });
});

describe("metrics", () => {
  const record = (over: Partial<CaseRecord>): CaseRecord => ({
    kase: { lane: "RECOVERED", recoveredPaise: 149900, amountPaise: 149900, failureReason: "card_declined", customerRef: "c", failedAt: "2026-09-01T00:00:00.000Z" } as never,
    attempts: [{ action: "RETRY_SCHEDULED", status: "RECOVERED" } as never],
    groundTruth: { recoverable: true, via: "RETRY", atHour: 8, selfRecovers: false, note: "x" },
    simHoursToResolution: 8,
    ...over,
  });

  it("counts recoveries, rupees and over-nudges", () => {
    const m = scoreArm("agent", [
      record({}),
      record({ kase: { lane: "ESCALATED", recoveredPaise: 0, amountPaise: 99900, failureReason: "risk", customerRef: "d", failedAt: "2026-09-01T00:00:00.000Z" } as never }),
      record({
        kase: { lane: "RECOVERED", recoveredPaise: 49900, amountPaise: 49900, failureReason: "x", customerRef: "e", failedAt: "2026-09-01T00:00:00.000Z" } as never,
        attempts: [{ action: "CUSTOMER_NUDGE", status: "RECOVERED" } as never],
        groundTruth: { recoverable: true, via: "CUSTOMER_NUDGE", atHour: 1, selfRecovers: true, note: "would have paid" },
      }),
    ]);
    expect(m.recovered).toBe(2);
    expect(m.recoveredPaise).toBe(199800);
    expect(m.escalations).toBe(1);
    expect(m.overNudges).toBe(1);
  });

  it("lists every unrecovered case as an exception with its ground-truth note", () => {
    const rows = exceptionList([
      record({ kase: { lane: "ESCALATED", failureReason: "card_expired", amountPaise: 1, customerRef: "z", recoveredPaise: 0, failedAt: "2026-09-01T00:00:00.000Z" } as never }),
      record({}),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.lane).toBe("ESCALATED");
  });
});
