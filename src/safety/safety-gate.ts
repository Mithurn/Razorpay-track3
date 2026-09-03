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

// A stable identifier for which guardrail fired — the "rule name" half of the audit record.
// `detail` (below) carries the human-readable specifics (the actual numbers involved); the two
// are deliberately separate fields, not one interpolated string, so a caller can group or filter
// by rule without parsing text.
export type GuardrailRule = "risk_hold" | "max_attempts" | "exposure_cap" | "low_confidence" | "cooldown";

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
  if (ctx.riskHold && proposal.kind !== "ESCALATE") {
    const detail = "the original payment carries a risk hold";
    return { outcome: "clamp", action: escalate(detail), rule: "risk_hold", detail };
  }

  if (ctx.attemptNo > limits.maxAttempts && belowEscalate) {
    const detail = `attempt ${ctx.attemptNo} exceeds the cap of ${limits.maxAttempts}`;
    return { outcome: "clamp", action: escalate(detail), rule: "max_attempts", detail };
  }

  const movesMoney =
    proposal.kind === "RETRY_NOW" || proposal.kind === "RETRY_SCHEDULED" || proposal.kind === "PAYMENT_LINK";

  if (movesMoney && ctx.case.amountPaise > limits.maxExposurePaise) {
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
