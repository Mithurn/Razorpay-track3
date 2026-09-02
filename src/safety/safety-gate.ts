import { CAUTION_RANK, type RecoveryAction } from "../domain/recovery-action.js";
import type { RecoveryCase } from "../domain/case.js";

// The deterministic fence around the agent. Pure. It may only make a proposal more cautious
// (clamp / veto / dedupe), never less, and it never chooses an action of its own.

export type SafetyLimits = {
  maxAttempts: number;
  maxExposurePaise: number;
  cooldownHours: number;
  minConfidence: number;
};

export const DEFAULT_LIMITS: SafetyLimits = {
  maxAttempts: 4,
  maxExposurePaise: 5_000_00,
  cooldownHours: 6,
  minConfidence: 0.6,
};

export type GateContext = {
  case: RecoveryCase;
  attemptNo: number;
  hoursSinceLastAttempt: number | null;
  riskHold: boolean;
  confidence: number;
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
  const belowEscalate = CAUTION_RANK[proposal.kind] < CAUTION_RANK.ESCALATE;

  // Not a rank test: WRITE_OFF ranks equal to ESCALATE because neither moves money, but it
  // closes the case with no human ever seeing it. A risk hold has exactly one acceptable end.
  if (ctx.riskHold && proposal.kind !== "ESCALATE") {
    return { outcome: "clamp", action: escalate("risk hold on the original payment"), reason: "risk_hold" };
  }

  if (ctx.attemptNo > limits.maxAttempts && belowEscalate) {
    return {
      outcome: "clamp",
      action: escalate(`attempt ${ctx.attemptNo} exceeds cap of ${limits.maxAttempts}`),
      reason: "max_attempts",
    };
  }

  const movesMoney =
    proposal.kind === "RETRY_NOW" || proposal.kind === "RETRY_SCHEDULED" || proposal.kind === "PAYMENT_LINK";

  if (movesMoney && ctx.case.amountPaise > limits.maxExposurePaise) {
    return {
      outcome: "clamp",
      action: escalate(`amount ${ctx.case.amountPaise} exceeds auto-recovery cap ${limits.maxExposurePaise}`),
      reason: "exposure_cap",
    };
  }

  if (movesMoney && ctx.confidence < limits.minConfidence) {
    return {
      outcome: "clamp",
      action: escalate(`confidence ${ctx.confidence} below auto-recovery floor ${limits.minConfidence}`),
      reason: "low_confidence",
    };
  }

  if (movesMoney && ctx.hoursSinceLastAttempt !== null && ctx.hoursSinceLastAttempt < limits.cooldownHours) {
    return { outcome: "skip", reason: `cooldown: ${ctx.hoursSinceLastAttempt.toFixed(1)}h < ${limits.cooldownHours}h` };
  }

  return { outcome: "allow", action: proposal };
}
