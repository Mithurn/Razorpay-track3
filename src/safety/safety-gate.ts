import { CAUTION_RANK, type RecoveryAction } from "../domain/recovery-action.js";
import type { RecoveryCase } from "../domain/case.js";

/**
 * The deterministic fence around the agent. It is a pure function and it may only
 * make a proposal MORE cautious (clamp / veto), never less. It never chooses an
 * action of its own — it reacts to the agent's proposal against hard limits.
 *
 * This is the "where we chose not to use AI" boundary. Keep it small and total.
 */

export type SafetyLimits = {
  maxAttempts: number; //         hard ceiling on retry attempts per case
  maxExposurePaise: number; //    do not auto-move more than this without a human
  cooldownHours: number; //       minimum gap between attempts
};

export const DEFAULT_LIMITS: SafetyLimits = {
  maxAttempts: 4,
  maxExposurePaise: 5_000_00, // ₹5,000
  cooldownHours: 6,
};

export type GateContext = {
  case: RecoveryCase;
  attemptNo: number; //           the attempt this proposal would become (1-indexed)
  hoursSinceLastAttempt: number | null;
  riskHold: boolean; //           issuer/gateway flagged the original payment as risky
};

export type GateResult =
  | { outcome: "allow"; action: RecoveryAction }
  | { outcome: "clamp"; action: RecoveryAction; reason: string }
  | { outcome: "skip"; reason: string };

const escalate = (reason: string): RecoveryAction => ({ kind: "ESCALATE", reason });

export function safetyGate(
  proposal: RecoveryAction,
  ctx: GateContext,
  limits: SafetyLimits = DEFAULT_LIMITS,
): GateResult {
  // Veto: a risk hold is never auto-actioned.
  if (ctx.riskHold && CAUTION_RANK[proposal.kind] < CAUTION_RANK.ESCALATE) {
    return { outcome: "clamp", action: escalate("risk hold on the original payment"), reason: "risk_hold" };
  }

  // Veto: attempt budget exhausted.
  if (ctx.attemptNo > limits.maxAttempts && CAUTION_RANK[proposal.kind] < CAUTION_RANK.ESCALATE) {
    return {
      outcome: "clamp",
      action: escalate(`attempt ${ctx.attemptNo} exceeds cap of ${limits.maxAttempts}`),
      reason: "max_attempts",
    };
  }

  // Veto: exposure cap. A money-moving action above the cap needs a human.
  const movesMoney = proposal.kind === "RETRY_NOW" || proposal.kind === "RETRY_SCHEDULED" || proposal.kind === "PAYMENT_LINK";
  if (movesMoney && ctx.case.amountPaise > limits.maxExposurePaise) {
    return {
      outcome: "clamp",
      action: escalate(`amount ${ctx.case.amountPaise} exceeds auto-recovery cap ${limits.maxExposurePaise}`),
      reason: "exposure_cap",
    };
  }

  // Dedupe: still inside the cooldown.
  if (
    movesMoney &&
    ctx.hoursSinceLastAttempt !== null &&
    ctx.hoursSinceLastAttempt < limits.cooldownHours
  ) {
    return { outcome: "skip", reason: `cooldown: ${ctx.hoursSinceLastAttempt.toFixed(1)}h < ${limits.cooldownHours}h` };
  }

  return { outcome: "allow", action: proposal };
}
