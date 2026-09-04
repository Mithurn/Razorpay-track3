import { CAUTION_RANK, MOVES_MONEY, type RecoveryAction } from "../domain/recovery-action.js";
import type { RecoveryCase } from "../domain/case.js";

// The deterministic fence around the agent. Pure. It never chooses an action of its own.
//
// No LLM-originated path can lower caution: with humanAuthorization null — the only state any
// agent proposal can produce — the gate may only clamp, veto or dedupe. A recorded human
// authorization can satisfy exactly the two vetoes that exist to demand a human decision
// (risk_hold, exposure_cap), and never hard_decline, the attempt cap, the contact window or the
// cooldown. Both halves are enumerated exhaustively in tests/safety-gate.test.ts.

export type SafetyLimits = {
  maxAttempts: number;
  maxExposurePaise: number;
  cooldownHours: number;
  minConfidence: number;
  /** Separate from cooldownHours: that paces charges, this paces messages to a person. */
  contactCooldownHours: number;
};

export const DEFAULT_LIMITS: SafetyLimits = {
  maxAttempts: 4,
  maxExposurePaise: 5_000_00,
  cooldownHours: 6,
  minConfidence: 0.6,
  contactCooldownHours: 24,
};

/**
 * A named person took responsibility for this action on an escalated case. Recorded in the audit
 * trail before it ever reaches the gate — see the HUMAN_DIRECTIVE event.
 */
export type HumanAuthorization = { approver: string; at: string };

export type GateContext = {
  case: RecoveryCase;
  attemptNo: number;
  hoursSinceLastAttempt: number | null;
  /** Hours since the customer was last messaged, across every outreach action. */
  hoursSinceLastContact: number | null;
  riskHold: boolean;
  hardDecline: boolean;
  unrecoverableDiagnosis: boolean;
  confidence: number;
  now: Date;
  /**
   * Null for every agent-originated proposal, which is the only path the LLM can reach. When
   * present it satisfies exactly two vetoes — risk_hold and exposure_cap — because those two
   * exist to force a human decision, and a human has now made it. It never satisfies
   * hard_decline (a card-network fine is not the merchant's to waive), the attempt cap, the
   * contact window, or the cooldown.
   */
  humanAuthorization: HumanAuthorization | null;
};

/** Vetoes a recorded human authorization is allowed to satisfy. Deliberately short. */
export const HUMAN_SATISFIABLE_RULES: ReadonlySet<GuardrailRule> = new Set(["risk_hold", "exposure_cap"]);

// A stable identifier for which guardrail fired — the "rule name" half of the audit record.
// `detail` (below) carries the human-readable specifics (the actual numbers involved); the two
// are deliberately separate fields, not one interpolated string, so a caller can group or filter
// by rule without parsing text.
export type GuardrailRule =
  | "risk_hold"
  | "hard_decline"
  | "max_attempts"
  | "exposure_cap"
  | "low_confidence"
  | "cooldown"
  | "contact_window"
  | "contact_cooldown"
  | "write_off_unsupported";

// Visa/Mastercard fine merchants for reattempting a decline that won't clear on its own;
// DEFAULT_LIMITS.maxAttempts already keeps every case under either network's cap, so only the
// hard-decline case below needs its own veto.
const AUTO_REATTEMPT: ReadonlySet<RecoveryAction["kind"]> = new Set(["RETRY_NOW", "RETRY_SCHEDULED"]);

// Modelled on the RBI Fair Practices Code's recovery-agent contact-hours norm (no contact before
// 08:00 or after 19:00 IST) — that guidance targets lenders' recovery agents, not a merchant
// retrying its own subscription charge, so this is a deliberately conservative adoption of the
// same standard, not a claim that a specific paragraph binds this case.
export const CONTACT_WINDOW_START_HOUR_IST = 8;
export const CONTACT_WINDOW_END_HOUR_IST = 19;
const IST_OFFSET_MIN = 330; // UTC+5:30, no DST

export function istMinutesOfDay(date: Date): number {
  return (date.getUTCHours() * 60 + date.getUTCMinutes() + IST_OFFSET_MIN) % 1440;
}

export function isWithinContactWindow(date: Date): boolean {
  const min = istMinutesOfDay(date);
  return min >= CONTACT_WINDOW_START_HOUR_IST * 60 && min < CONTACT_WINDOW_END_HOUR_IST * 60;
}

/** How long until the window next opens — 0 if already inside it. */
export function msUntilContactWindowOpens(date: Date): number {
  const min = istMinutesOfDay(date);
  const startMin = CONTACT_WINDOW_START_HOUR_IST * 60;
  const endMin = CONTACT_WINDOW_END_HOUR_IST * 60;
  if (min >= startMin && min < endMin) return 0;
  const minutesUntil = min < startMin ? startMin - min : 1440 - min + startMin;
  return minutesUntil * 60_000;
}

export type GateResult =
  | { outcome: "allow"; action: RecoveryAction }
  | { outcome: "clamp"; action: RecoveryAction; rule: GuardrailRule; detail: string }
  | { outcome: "skip"; rule: GuardrailRule; detail: string };

const escalate = (reason: string): RecoveryAction => ({ kind: "ESCALATE", reason });

export function safetyGate(
  proposal: RecoveryAction,
  ctx: GateContext,
  limits: SafetyLimits = DEFAULT_LIMITS,
): GateResult {
  const belowEscalate = CAUTION_RANK[proposal.kind] < CAUTION_RANK.ESCALATE;

  // Not a rank test: WRITE_OFF ranks equal to ESCALATE because neither moves money, but it
  // closes the case with no human ever seeing it. A risk hold has exactly one acceptable end.
  if (ctx.riskHold && proposal.kind !== "ESCALATE" && !ctx.humanAuthorization) {
    const detail = "the original payment carries a risk hold";
    return { outcome: "clamp", action: escalate(detail), rule: "risk_hold", detail };
  }

  if (proposal.kind === "WRITE_OFF" && !ctx.unrecoverableDiagnosis) {
    const detail = "write-off requires an unrecoverable diagnosis; anything less goes to a human";
    return { outcome: "clamp", action: escalate(detail), rule: "write_off_unsupported", detail };
  }

  // Read from the case data, not the diagnosis — holds even on a degraded fallback's default retry.
  if (ctx.hardDecline && AUTO_REATTEMPT.has(proposal.kind)) {
    const detail =
      "the card itself declined this payment; an automatic reattempt on the same instrument is a card-network compliance violation, not a recoverable state";
    return { outcome: "clamp", action: escalate(detail), rule: "hard_decline", detail };
  }

  if (ctx.attemptNo > limits.maxAttempts && belowEscalate) {
    const detail = `attempt ${ctx.attemptNo} exceeds the cap of ${limits.maxAttempts}`;
    return { outcome: "clamp", action: escalate(detail), rule: "max_attempts", detail };
  }

  if (proposal.kind === "CUSTOMER_NUDGE" && !isWithinContactWindow(ctx.now)) {
    const detail = `outside the ${CONTACT_WINDOW_START_HOUR_IST}:00-${CONTACT_WINDOW_END_HOUR_IST}:00 IST contact window (modelled on the RBI Fair Practices Code)`;
    return { outcome: "skip", rule: "contact_window", detail };
  }

  // A person, not a card. cooldownHours paces charges against the bank; this paces messages
  // against someone's inbox, and a human authorization does not buy the right to nag.
  if (
    proposal.kind === "CUSTOMER_NUDGE" &&
    ctx.hoursSinceLastContact !== null &&
    ctx.hoursSinceLastContact < limits.contactCooldownHours
  ) {
    const detail = `${ctx.hoursSinceLastContact.toFixed(1)}h since this customer was last contacted, below the ${limits.contactCooldownHours}h contact cooldown`;
    return { outcome: "skip", rule: "contact_cooldown", detail };
  }

  const movesMoney = MOVES_MONEY.has(proposal.kind);

  if (movesMoney && ctx.case.amountPaise > limits.maxExposurePaise && !ctx.humanAuthorization) {
    const detail = `amount ${ctx.case.amountPaise} exceeds the auto-recovery cap of ${limits.maxExposurePaise}`;
    return { outcome: "clamp", action: escalate(detail), rule: "exposure_cap", detail };
  }

  if (movesMoney && ctx.confidence < limits.minConfidence) {
    const detail = `confidence ${ctx.confidence} is below the auto-recovery floor of ${limits.minConfidence}`;
    return { outcome: "clamp", action: escalate(detail), rule: "low_confidence", detail };
  }

  if (movesMoney && ctx.hoursSinceLastAttempt !== null && ctx.hoursSinceLastAttempt < limits.cooldownHours) {
    const detail = `${ctx.hoursSinceLastAttempt.toFixed(1)}h since the last attempt, below the ${limits.cooldownHours}h cooldown`;
    return { outcome: "skip", rule: "cooldown", detail };
  }

  return { outcome: "allow", action: proposal };
}
