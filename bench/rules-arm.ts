import type { AgentRunner } from "../src/worker/pipeline.js";
import type { RecoveryAction } from "../src/domain/recovery-action.js";

// A third arm: the agent's own system-prompt playbook, transcribed into a switch. No model.

function firstMove(failureReason: string): RecoveryAction {
  switch (failureReason) {
    case "card_expired":
      return { kind: "CUSTOMER_NUDGE", channel: "email" };
    case "payment_failed":
      return { kind: "PAYMENT_LINK", rail: "netbanking" };
    case "payment_risk_check_failed":
      return { kind: "ESCALATE", reason: "risk-flagged payment" };
    case "insufficient_funds":
      return { kind: "RETRY_SCHEDULED", atHoursFromNow: 72 };
    case "issuer_technical_error":
      return { kind: "RETRY_SCHEDULED", atHoursFromNow: 24 };
    default:
      return { kind: "RETRY_SCHEDULED", atHoursFromNow: 12 };
  }
}

export const rulesRunner: AgentRunner = async (deps) => {
  const attemptNo = deps.priorAttempts.filter((a) => a.status !== "SKIPPED").length;
  const first = firstMove(deps.kase.failureReason);
  const action: RecoveryAction =
    attemptNo === 0
      ? first
      : first.kind === "RETRY_SCHEDULED"
        ? { kind: "RETRY_SCHEDULED", atHoursFromNow: 72 }
        : { kind: "ESCALATE", reason: "first move did not recover" };
  return {
    action,
    diagnosisRootCause: null,
    confidence: 1,
    reasoning: `rules table on error_reason=${deps.kase.failureReason}`,
    toolCalls: 0,
    degraded: false,
  };
};
