import { describe, expect, it } from "vitest";
import { CAUTION_RANK, type RecoveryAction } from "../src/domain/recovery-action.js";
import type { RecoveryCase } from "../src/domain/case.js";
import { DEFAULT_LIMITS, safetyGate, type GateContext } from "../src/safety/safety-gate.js";

// The gate is the fence around the agent. Its one guarantee is directional: whatever the agent
// proposes, the outcome is never less cautious. The space is small enough to enumerate
// exhaustively, which is a stronger claim than sampling.

const PROPOSALS: RecoveryAction[] = [
  { kind: "RETRY_NOW" },
  { kind: "RETRY_SCHEDULED", atHoursFromNow: 48 },
  { kind: "PAYMENT_LINK", rail: "card" },
  { kind: "CUSTOMER_NUDGE", channel: "email" },
  { kind: "ESCALATE", reason: "agent asked for a human" },
  { kind: "WRITE_OFF", reason: "agent gave up" },
];

const MOVES_MONEY: RecoveryAction["kind"][] = ["RETRY_NOW", "RETRY_SCHEDULED", "PAYMENT_LINK"];

function buildCase(amountPaise: number): RecoveryCase {
  return {
    id: "3f1d9a2e-0000-4000-8000-000000000001",
    runId: null,
    merchantRef: "merch_1",
    customerRef: "cust_1",
    originalPaymentId: null,
    amountPaise,
    currency: "INR",
    failureCode: "BAD_REQUEST_ERROR",
    failureReason: "card_declined",
    failedAt: new Date().toISOString(),
    method: "card",
    instrument: null,
    customerHistory: [],
    lane: "DECIDING",
    recoveredPaise: 0,
  };
}

const CONTEXTS: GateContext[] = [];
for (const riskHold of [false, true]) {
  for (const attemptNo of [1, DEFAULT_LIMITS.maxAttempts, DEFAULT_LIMITS.maxAttempts + 1]) {
    for (const amountPaise of [DEFAULT_LIMITS.maxExposurePaise - 1, DEFAULT_LIMITS.maxExposurePaise + 1]) {
      for (const hoursSinceLastAttempt of [null, 0, DEFAULT_LIMITS.cooldownHours - 1, DEFAULT_LIMITS.cooldownHours + 1]) {
        CONTEXTS.push({ case: buildCase(amountPaise), attemptNo, hoursSinceLastAttempt, riskHold });
      }
    }
  }
}

describe("safetyGate", () => {
  it("enumerates a meaningful space", () => {
    expect(PROPOSALS.length * CONTEXTS.length).toBe(288);
  });

  it("never returns an outcome less cautious than the proposal", () => {
    for (const proposal of PROPOSALS) {
      for (const ctx of CONTEXTS) {
        const result = safetyGate(proposal, ctx);
        if (result.outcome === "skip") continue; // nothing happens at all
        expect(CAUTION_RANK[result.action.kind]).toBeGreaterThanOrEqual(CAUTION_RANK[proposal.kind]);
      }
    }
  });

  it("never invents a money-moving action the agent did not propose", () => {
    for (const proposal of PROPOSALS) {
      for (const ctx of CONTEXTS) {
        const result = safetyGate(proposal, ctx);
        if (result.outcome === "skip") continue;
        if (MOVES_MONEY.includes(result.action.kind)) {
          expect(result.action).toEqual(proposal);
        }
      }
    }
  });

  it("ends every risk-hold case at ESCALATE, whatever was proposed", () => {
    for (const proposal of PROPOSALS) {
      for (const ctx of CONTEXTS.filter((c) => c.riskHold)) {
        const result = safetyGate(proposal, ctx);
        expect(result.outcome).not.toBe("skip");
        if (result.outcome !== "skip") expect(result.action.kind).toBe("ESCALATE");
        expect(result.outcome).toBe(proposal.kind === "ESCALATE" ? "allow" : "clamp");
      }
    }
  });

  it("does not let WRITE_OFF bury a risk-flagged case without a human", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      hoursSinceLastAttempt: null,
      riskHold: true,
    };
    const result = safetyGate({ kind: "WRITE_OFF", reason: "looks fraudulent" }, ctx);
    expect(result.outcome).toBe("clamp");
    if (result.outcome === "clamp") {
      expect(result.action.kind).toBe("ESCALATE");
      expect(result.reason).toBe("risk_hold");
    }
  });

  it("forces ESCALATE past the attempt cap", () => {
    const ctx = CONTEXTS.find(
      (c) => !c.riskHold && c.attemptNo === DEFAULT_LIMITS.maxAttempts + 1,
    )!;
    const result = safetyGate({ kind: "RETRY_NOW" }, ctx);
    expect(result.outcome).toBe("clamp");
    if (result.outcome === "clamp") expect(result.action.kind).toBe("ESCALATE");
  });

  it("forces ESCALATE over the exposure cap, but only for money-moving proposals", () => {
    const over = {
      case: buildCase(DEFAULT_LIMITS.maxExposurePaise + 1),
      attemptNo: 1,
      hoursSinceLastAttempt: null,
      riskHold: false,
    };
    expect(safetyGate({ kind: "RETRY_NOW" }, over).outcome).toBe("clamp");
    expect(safetyGate({ kind: "CUSTOMER_NUDGE", channel: "email" }, over).outcome).toBe("allow");
  });

  it("skips a money-moving proposal inside the cooldown, and lets it through outside", () => {
    const base = { case: buildCase(1000), attemptNo: 2, riskHold: false };
    const inside = safetyGate({ kind: "RETRY_NOW" }, { ...base, hoursSinceLastAttempt: 1 });
    const outside = safetyGate({ kind: "RETRY_NOW" }, { ...base, hoursSinceLastAttempt: 99 });
    expect(inside.outcome).toBe("skip");
    expect(outside.outcome).toBe("allow");
  });

  it("passes an unremarkable proposal through untouched", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      hoursSinceLastAttempt: null,
      riskHold: false,
    };
    const proposal: RecoveryAction = { kind: "RETRY_SCHEDULED", atHoursFromNow: 48 };
    const result = safetyGate(proposal, ctx);
    expect(result.outcome).toBe("allow");
    if (result.outcome === "allow") expect(result.action).toEqual(proposal);
  });

  it("is pure — the same inputs give the same result and the context is not mutated", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      hoursSinceLastAttempt: null,
      riskHold: false,
    };
    const snapshot = JSON.stringify(ctx);
    const a = safetyGate({ kind: "RETRY_NOW" }, ctx);
    const b = safetyGate({ kind: "RETRY_NOW" }, ctx);
    expect(a).toEqual(b);
    expect(JSON.stringify(ctx)).toBe(snapshot);
  });
});
