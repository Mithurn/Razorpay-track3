import type { RecoveryAction } from "../domain/recovery-action.js";

// Fields beyond `kind` do not affect settling, so defaults stand.
export function reconstructAction(kind: RecoveryAction["kind"]): RecoveryAction {
  switch (kind) {
    case "RETRY_NOW":
      return { kind };
    case "RETRY_SCHEDULED":
      return { kind, atHoursFromNow: 48 };
    case "PAYMENT_LINK":
      return { kind, rail: "card" };
    case "CUSTOMER_NUDGE":
      return { kind, channel: "email" };
    case "ESCALATE":
      return { kind, reason: "reconcile" };
    case "WRITE_OFF":
      return { kind, reason: "reconcile" };
  }
}
