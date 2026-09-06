import { describe, expect, it } from "vitest";
import {
  CAUTION_RANK,
  type RecoveryAction,
} from "../src/domain/recovery-action.js";
import type { RecoveryCase } from "../src/domain/case.js";
import {
  DEFAULT_LIMITS,
  safetyGate,
  isWithinContactWindow,
  msUntilContactWindowOpens,
  type GateContext,
} from "../src/safety/safety-gate.js";

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

const MOVES_MONEY: RecoveryAction["kind"][] = [
  "RETRY_NOW",
  "RETRY_SCHEDULED",
  "PAYMENT_LINK",
];

// Fixed IST-anchored instants, used everywhere a test does not care about the contact window.
const IN_WINDOW = new Date("2026-09-01T10:00:00+05:30"); // 10:00 IST
const OUT_OF_WINDOW = new Date("2026-09-01T02:00:00+05:30"); // 02:00 IST

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
  for (const hardDecline of [false, true]) {
    for (const unrecoverableDiagnosis of [false, true]) {
      for (const now of [IN_WINDOW, OUT_OF_WINDOW]) {
        for (const attemptNo of [
          1,
          DEFAULT_LIMITS.maxAttempts,
          DEFAULT_LIMITS.maxAttempts + 1,
        ]) {
          for (const amountPaise of [
            DEFAULT_LIMITS.maxExposurePaise - 1,
            DEFAULT_LIMITS.maxExposurePaise + 1,
          ]) {
            for (const hoursSinceLastAttempt of [
              null,
              0,
              DEFAULT_LIMITS.cooldownHours - 1,
              DEFAULT_LIMITS.cooldownHours + 1,
            ]) {
              for (const confidence of [
                DEFAULT_LIMITS.minConfidence - 0.1,
                1,
              ]) {
                CONTEXTS.push({
                  case: buildCase(amountPaise),
                  attemptNo,
                  humanAuthorization: null,
                  hoursSinceLastContact: null,
                  hoursSinceLastAttempt,
                  riskHold,
                  hardDecline,
                  unrecoverableDiagnosis,
                  confidence,
                  now,
                });
              }
            }
          }
        }
      }
    }
  }
}

describe("safetyGate", () => {
  it("enumerates a meaningful space", () => {
    expect(PROPOSALS.length * CONTEXTS.length).toBe(4608);
  });

  it("never returns an outcome less cautious than the proposal", () => {
    for (const proposal of PROPOSALS) {
      for (const ctx of CONTEXTS) {
        const result = safetyGate(proposal, ctx);
        if (result.outcome === "skip") continue; // nothing happens at all
        expect(CAUTION_RANK[result.action.kind]).toBeGreaterThanOrEqual(
          CAUTION_RANK[proposal.kind],
        );
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
        if (result.outcome !== "skip")
          expect(result.action.kind).toBe("ESCALATE");
        expect(result.outcome).toBe(
          proposal.kind === "ESCALATE" ? "allow" : "clamp",
        );
      }
    }
  });

  it("does not let WRITE_OFF bury a risk-flagged case without a human", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: true,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    const result = safetyGate(
      { kind: "WRITE_OFF", reason: "looks fraudulent" },
      ctx,
    );
    expect(result.outcome).toBe("clamp");
    if (result.outcome === "clamp") {
      expect(result.action.kind).toBe("ESCALATE");
      expect(result.rule).toBe("risk_hold");
    }
  });

  it("clamps an automatic reattempt on a hard-declined card, whatever the confidence", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: true,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    for (const kind of ["RETRY_NOW", "RETRY_SCHEDULED"] as const) {
      const proposal = PROPOSALS.find((p) => p.kind === kind)!;
      const result = safetyGate(proposal, ctx);
      expect(result.outcome).toBe("clamp");
      if (result.outcome === "clamp") {
        expect(result.action.kind).toBe("ESCALATE");
        expect(result.rule).toBe("hard_decline");
      }
    }
  });

  it("leaves a payment link or a nudge on a hard-declined card untouched — not an automatic reattempt", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: true,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    for (const kind of ["PAYMENT_LINK", "CUSTOMER_NUDGE"] as const) {
      const proposal = PROPOSALS.find((p) => p.kind === kind)!;
      expect(safetyGate(proposal, ctx).outcome).toBe("allow");
    }
  });

  it("a degraded loop's safe-fallback retry is exactly what the hard-decline veto is for", () => {
    // Mirrors recovery-agent.ts's SAFE_FALLBACK, which is a retry — the gate must still veto it.
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: true,
      unrecoverableDiagnosis: false,
      confidence: 1, // pipeline.ts sets confidence: 1 for a degraded proposal
      now: IN_WINDOW,
    };
    const result = safetyGate(
      { kind: "RETRY_SCHEDULED", atHoursFromNow: 48 },
      ctx,
    );
    expect(result.outcome).toBe("clamp");
    if (result.outcome === "clamp") expect(result.action.kind).toBe("ESCALATE");
  });

  it("clamps a write-off with no unrecoverable diagnosis to ESCALATE", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    const result = safetyGate(
      { kind: "WRITE_OFF", reason: "customer said to" },
      ctx,
    );
    expect(result.outcome).toBe("clamp");
    if (result.outcome === "clamp") {
      expect(result.action.kind).toBe("ESCALATE");
      expect(result.rule).toBe("write_off_unsupported");
    }
  });

  it("escalates a write-off that has no independent hard-decline signal and no human auth", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: true,
      confidence: 1,
      now: IN_WINDOW,
    };
    const result = safetyGate({ kind: "WRITE_OFF", reason: "account never funds" }, ctx);
    expect(result.outcome).toBe("clamp");
    if (result.outcome === "clamp") {
      expect(result.action.kind).toBe("ESCALATE");
      expect(result.rule).toBe("write_off_unsupported");
    }
  });

  it("allows a write-off backed by an unrecoverable diagnosis and an independent hard-decline signal", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: true,
      unrecoverableDiagnosis: true,
      confidence: 1,
      now: IN_WINDOW,
    };
    const result = safetyGate({ kind: "WRITE_OFF", reason: "card permanently declined" }, ctx);
    expect(result.outcome).toBe("allow");
  });

  it("allows a write-off on human authorization even without a hard-decline signal", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: { approver: "ops@merchant.com", at: new Date().toISOString() },
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: true,
      confidence: 1,
      now: IN_WINDOW,
    };
    const result = safetyGate({ kind: "WRITE_OFF", reason: "operator confirmed unrecoverable" }, ctx);
    expect(result.outcome).toBe("allow");
  });

  it("forces ESCALATE past the attempt cap", () => {
    const ctx = CONTEXTS.find(
      (c) =>
        !c.riskHold &&
        c.attemptNo === DEFAULT_LIMITS.maxAttempts + 1 &&
        c.confidence === 1,
    )!;
    const result = safetyGate({ kind: "RETRY_NOW" }, ctx);
    expect(result.outcome).toBe("clamp");
    if (result.outcome === "clamp") expect(result.action.kind).toBe("ESCALATE");
  });

  it("clamps a money-moving proposal whose confidence is below the floor", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: DEFAULT_LIMITS.minConfidence - 0.1,
      now: IN_WINDOW,
    };
    for (const kind of MOVES_MONEY) {
      const proposal = PROPOSALS.find((p) => p.kind === kind)!;
      const result = safetyGate(proposal, ctx);
      expect(result.outcome).toBe("clamp");
      if (result.outcome === "clamp") {
        expect(result.action.kind).toBe("ESCALATE");
        expect(result.rule).toBe("low_confidence");
      }
    }
  });

  it("lets a low-confidence nudge through inside the window: caution can only rise, not fall", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: DEFAULT_LIMITS.minConfidence - 0.1,
      now: IN_WINDOW,
    };
    const result = safetyGate(
      { kind: "CUSTOMER_NUDGE", channel: "email" },
      ctx,
    );
    expect(result.outcome).toBe("allow");
  });

  it("forces ESCALATE over the exposure cap, but only for money-moving proposals", () => {
    const over: GateContext = {
      case: buildCase(DEFAULT_LIMITS.maxExposurePaise + 1),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    expect(safetyGate({ kind: "RETRY_NOW" }, over).outcome).toBe("clamp");
    expect(
      safetyGate({ kind: "CUSTOMER_NUDGE", channel: "email" }, over).outcome,
    ).toBe("allow");
  });

  it("skips a money-moving proposal inside the cooldown, and lets it through outside", () => {
    const base = {
      case: buildCase(1000),
      attemptNo: 2,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    const inside = safetyGate(
      { kind: "RETRY_NOW" },
      { ...base, hoursSinceLastAttempt: 1 },
    );
    const outside = safetyGate(
      { kind: "RETRY_NOW" },
      { ...base, hoursSinceLastAttempt: 99 },
    );
    expect(inside.outcome).toBe("skip");
    expect(outside.outcome).toBe("allow");
  });

  it("passes an unremarkable proposal through untouched", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    const proposal: RecoveryAction = {
      kind: "RETRY_SCHEDULED",
      atHoursFromNow: 48,
    };
    const result = safetyGate(proposal, ctx);
    expect(result.outcome).toBe("allow");
    if (result.outcome === "allow") expect(result.action).toEqual(proposal);
  });

  it("carries a stable rule id separate from the human-readable detail, for every outcome", () => {
    const passing: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    const allow = safetyGate({ kind: "RETRY_NOW" }, passing);
    expect(allow.outcome).toBe("allow");

    const clamp = safetyGate(
      { kind: "RETRY_NOW" },
      { ...passing, riskHold: true },
    );
    expect(clamp).toMatchObject({ outcome: "clamp", rule: "risk_hold" });
    if (clamp.outcome === "clamp") expect(typeof clamp.detail).toBe("string");

    const skip = safetyGate(
      { kind: "RETRY_NOW" },
      { ...passing, attemptNo: 2, hoursSinceLastAttempt: 1 },
    );
    expect(skip).toMatchObject({ outcome: "skip", rule: "cooldown" });
    if (skip.outcome === "skip") expect(typeof skip.detail).toBe("string");
  });

  it("is pure — the same inputs give the same result and the context is not mutated", () => {
    const ctx: GateContext = {
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    };
    const snapshot = JSON.stringify(ctx);
    const a = safetyGate({ kind: "RETRY_NOW" }, ctx);
    const b = safetyGate({ kind: "RETRY_NOW" }, ctx);
    expect(a).toEqual(b);
    expect(JSON.stringify(ctx)).toBe(snapshot);
  });

  describe("contact window (RBI Fair Practices Code, 08:00-19:00 IST)", () => {
    const baseCtx = (now: Date): GateContext => ({
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact: null,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now,
    });

    it("skips a nudge proposed outside the window, and does not touch any other action", () => {
      const ctx = baseCtx(OUT_OF_WINDOW);
      const nudge = safetyGate({ kind: "CUSTOMER_NUDGE", channel: "sms" }, ctx);
      expect(nudge).toMatchObject({ outcome: "skip", rule: "contact_window" });

      for (const proposal of PROPOSALS.filter(
        (p) => p.kind !== "CUSTOMER_NUDGE",
      )) {
        const result = safetyGate(proposal, ctx);
        expect(result.outcome).not.toBe("skip");
      }
    });

    it("lets a nudge through inside the window", () => {
      const result = safetyGate(
        { kind: "CUSTOMER_NUDGE", channel: "email" },
        baseCtx(IN_WINDOW),
      );
      expect(result.outcome).toBe("allow");
    });

    it("treats the window as a half-open interval: 08:00 is inside, 19:00 is outside", () => {
      const opens = safetyGate(
        { kind: "CUSTOMER_NUDGE", channel: "email" },
        baseCtx(new Date("2026-09-01T08:00:00+05:30")),
      );
      const closes = safetyGate(
        { kind: "CUSTOMER_NUDGE", channel: "email" },
        baseCtx(new Date("2026-09-01T19:00:00+05:30")),
      );
      expect(opens.outcome).toBe("allow");
      expect(closes.outcome).toBe("skip");
    });

    it("isWithinContactWindow agrees with the gate's own decision", () => {
      expect(isWithinContactWindow(IN_WINDOW)).toBe(true);
      expect(isWithinContactWindow(OUT_OF_WINDOW)).toBe(false);
    });

    it("msUntilContactWindowOpens is 0 inside the window and counts forward correctly outside it", () => {
      expect(msUntilContactWindowOpens(IN_WINDOW)).toBe(0);
      // 02:00 IST -> 08:00 IST the same day is 6 hours.
      expect(msUntilContactWindowOpens(OUT_OF_WINDOW)).toBe(6 * 3_600_000);
      // 20:00 IST -> 08:00 IST the next day is 12 hours.
      expect(
        msUntilContactWindowOpens(new Date("2026-09-01T20:00:00+05:30")),
      ).toBe(12 * 3_600_000);
    });
  });

  describe("contact cooldown (separate from cooldownHours — paces messages, not charges)", () => {
    const ctx = (hoursSinceLastContact: number | null): GateContext => ({
      case: buildCase(149900),
      attemptNo: 1,
      humanAuthorization: null,
      hoursSinceLastContact,
      hoursSinceLastAttempt: null,
      riskHold: false,
      hardDecline: false,
      unrecoverableDiagnosis: false,
      confidence: 1,
      now: IN_WINDOW,
    });
    const nudge: RecoveryAction = { kind: "CUSTOMER_NUDGE", channel: "email" };

    it("skips a second nudge inside the contact cooldown", () => {
      const result = safetyGate(nudge, ctx(DEFAULT_LIMITS.contactCooldownHours - 1));
      expect(result).toMatchObject({ outcome: "skip", rule: "contact_cooldown" });
    });

    it("allows a nudge once the contact cooldown has passed, or when there was no prior contact", () => {
      expect(safetyGate(nudge, ctx(DEFAULT_LIMITS.contactCooldownHours + 1)).outcome).toBe("allow");
      expect(safetyGate(nudge, ctx(null)).outcome).toBe("allow");
    });

    it("does not touch a charge — only messages are paced by this rule", () => {
      const withinContactCooldown = ctx(1);
      for (const kind of ["RETRY_NOW", "RETRY_SCHEDULED", "PAYMENT_LINK"] as const) {
        const proposal = PROPOSALS.find((p) => p.kind === kind)!;
        expect(safetyGate(proposal, withinContactCooldown).outcome).not.toBe("skip");
      }
    });

    it("a human authorization does not buy the right to nag", () => {
      const authorized = { ...ctx(1), humanAuthorization: { approver: "ops@acme.test", at: "2026-09-01T10:00:00.000Z" } };
      expect(safetyGate(nudge, authorized)).toMatchObject({ outcome: "skip", rule: "contact_cooldown" });
    });
  });

  // A human authorization is the ONLY thing that can lower caution, and only over the two vetoes
  // that exist to demand a human decision in the first place. Every context above carries
  // humanAuthorization: null — those 4608 assertions are the "no LLM path can lower caution" half
  // of the invariant. These are the other half: what a signed-off human may and may not do.
  describe("human authorization", () => {
    const APPROVER = {
      approver: "ops@acme.test",
      at: "2026-09-01T10:00:00.000Z",
    };
    const authorized = (ctx: GateContext): GateContext => ({
      ...ctx,
      humanAuthorization: APPROVER,
    });

    it("changes nothing at all when absent — the agent-only space is untouched", () => {
      for (const proposal of PROPOSALS) {
        for (const ctx of CONTEXTS) {
          expect(ctx.humanAuthorization).toBeNull();
          expect(safetyGate(proposal, ctx)).toEqual(
            safetyGate(proposal, { ...ctx }),
          );
        }
      }
    });

    it("lets a human retry a risk hold the agent could never have retried", () => {
      const ctx = CONTEXTS.find(
        (c) =>
          c.riskHold &&
          !c.hardDecline &&
          c.attemptNo === 1 &&
          c.hoursSinceLastAttempt === null &&
          c.confidence === 1,
      )!;
      const proposal: RecoveryAction = { kind: "RETRY_NOW" };
      expect(safetyGate(proposal, ctx).outcome).toBe("clamp");
      expect(safetyGate(proposal, authorized(ctx)).outcome).toBe("allow");
    });

    it("lets a human authorize a payment over the exposure cap", () => {
      const ctx = CONTEXTS.find(
        (c) =>
          !c.riskHold &&
          !c.hardDecline &&
          c.attemptNo === 1 &&
          c.hoursSinceLastAttempt === null &&
          c.confidence === 1 &&
          c.case.amountPaise > DEFAULT_LIMITS.maxExposurePaise,
      )!;
      const proposal: RecoveryAction = { kind: "PAYMENT_LINK", rail: "card" };
      expect(safetyGate(proposal, ctx).outcome).toBe("clamp");
      expect(safetyGate(proposal, authorized(ctx)).outcome).toBe("allow");
    });

    it("never lets a human waive a hard decline or the attempt cap", () => {
      for (const proposal of PROPOSALS) {
        for (const ctx of CONTEXTS) {
          const result = safetyGate(proposal, authorized(ctx));
          if (result.outcome === "skip") continue;
          // A card-network fine and the attempt limit are not the merchant's to waive.
          if (
            ctx.hardDecline &&
            (proposal.kind === "RETRY_NOW" ||
              proposal.kind === "RETRY_SCHEDULED")
          ) {
            expect(result.action.kind).toBe("ESCALATE");
          }
          if (
            ctx.attemptNo > DEFAULT_LIMITS.maxAttempts &&
            CAUTION_RANK[proposal.kind] < CAUTION_RANK.ESCALATE
          ) {
            expect(result.action.kind).toBe("ESCALATE");
          }
        }
      }
    });

    it("never lets a human contact a customer outside the RBI window or inside a cooldown", () => {
      for (const ctx of CONTEXTS) {
        const auth = authorized(ctx);
        // The attempt cap outranks the contact window, so a past-cap context clamps before the
        // rule under test is reached.
        if (
          !isWithinContactWindow(ctx.now) &&
          ctx.attemptNo <= DEFAULT_LIMITS.maxAttempts
        ) {
          expect(
            safetyGate({ kind: "CUSTOMER_NUDGE", channel: "email" }, auth)
              .outcome,
          ).toBe("skip");
        }
        // Confidence is checked before cooldown, so a low-confidence context clamps first and
        // never reaches the rule under test here.
        const withinCooldown =
          ctx.hoursSinceLastAttempt !== null &&
          ctx.hoursSinceLastAttempt < DEFAULT_LIMITS.cooldownHours;
        if (
          withinCooldown &&
          !ctx.riskHold &&
          !ctx.hardDecline &&
          ctx.confidence >= DEFAULT_LIMITS.minConfidence &&
          ctx.attemptNo <= DEFAULT_LIMITS.maxAttempts
        ) {
          expect(safetyGate({ kind: "RETRY_NOW" }, auth).outcome).toBe("skip");
        }
      }
    });
  });
});
