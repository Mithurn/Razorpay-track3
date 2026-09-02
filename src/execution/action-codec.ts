import type { RecoveryAction } from "../domain/recovery-action.js";

// The attempt row stores only the action kind. Reconciliation and webhook settling need a
// RecoveryAction shape again; the fields beyond `kind` do not affect settling, so defaults stand.

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
