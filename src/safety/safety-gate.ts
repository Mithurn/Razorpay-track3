import { CAUTION_RANK, MOVES_MONEY, type RecoveryAction } from "../domain/recovery-action.js";
import type { RecoveryCase } from "../domain/case.js";

export type SafetyLimits = {
  maxAttempts: number;
  maxExposurePaise: number;
  cooldownHours: number;
  minConfidence: number;
  contactCooldownHours: number;
};

export const DEFAULT_LIMITS: SafetyLimits = {
  maxAttempts: 4,
  maxExposurePaise: 5_000_00,
  cooldownHours: 6,
  minConfidence: 0.6,
  contactCooldownHours: 24,
};

export type HumanAuthorization = { approver: string; at: string };

export type GateContext = {
  case: RecoveryCase;
  attemptNo: number;
  hoursSinceLastAttempt: number | null;
  hoursSinceLastContact: number | null;
  riskHold: boolean;
  hardDecline: boolean;
  unrecoverableDiagnosis: boolean;
  confidence: number;
  now: Date;
  // Null for every agent-originated proposal. Satisfies only risk_hold and exposure_cap; never
  // hard_decline, the attempt cap, the contact window, or the cooldown.
  humanAuthorization: HumanAuthorization | null;
};

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

const AUTO_REATTEMPT: ReadonlySet<RecoveryAction["kind"]> = new Set(["RETRY_NOW", "RETRY_SCHEDULED"]);

// Modelled on the RBI Fair Practices Code's recovery-agent contact-hours norm, applied here as a
// deliberately conservative adoption, not a claim that a specific paragraph binds this case.
export const CONTACT_WINDOW_START_HOUR_IST = 8;
export const CONTACT_WINDOW_END_HOUR_IST = 19;
const IST_OFFSET_MIN = 330; // UTC+5:30, no DST

function istMinutesOfDay(date: Date): number {
  return (date.getUTCHours() * 60 + date.getUTCMinutes() + IST_OFFSET_MIN) % 1440;
}

export function isWithinContactWindow(date: Date): boolean {
  const min = istMinutesOfDay(date);
  return min >= CONTACT_WINDOW_START_HOUR_IST * 60 && min < CONTACT_WINDOW_END_HOUR_IST * 60;
}

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

  if (ctx.riskHold && proposal.kind !== "ESCALATE" && !ctx.humanAuthorization) {
    const detail = "the original payment carries a risk hold";
    return { outcome: "clamp", action: escalate(detail), rule: "risk_hold", detail };
  }

  if (proposal.kind === "WRITE_OFF" && !ctx.unrecoverableDiagnosis) {
    const detail = "write-off requires an unrecoverable diagnosis; anything less goes to a human";
    return { outcome: "clamp", action: escalate(detail), rule: "write_off_unsupported", detail };
  }

  // The agent's own diagnosis is the only source of unrecoverableDiagnosis — it has no independent
  // case-level backstop the way riskHold and hardDecline do. Require an independent signal:
  // either a hard-decline flag (set from case data, not the diagnosis) or explicit human sign-off.
  // Without one, escalate so a human confirms before the case is permanently closed.
  if (proposal.kind === "WRITE_OFF" && !ctx.hardDecline && !ctx.humanAuthorization) {
    const detail =
      "write-off without a hard-decline signal requires human sign-off; the unrecoverable diagnosis has no independent case-level backstop";
    return { outcome: "clamp", action: escalate(detail), rule: "write_off_unsupported", detail };
  }

  // Read from the case data, not the diagnosis.
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
