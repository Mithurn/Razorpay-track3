import type { Attempt, Clock } from "../domain/attempt.js";
import type { RecoveryCase } from "../domain/case.js";
import type { AgentProposal } from "../domain/recovery-action.js";
import { MOVES_MONEY } from "../domain/recovery-action.js";
import type { GateContext } from "../safety/safety-gate.js";
import type { HumanDirective } from "./human-directive.js";

// Outreach only: a charge the customer never sees is not contact.
const OUTREACH: ReadonlySet<AgentProposal["action"]["kind"]> = new Set(["CUSTOMER_NUDGE", "PAYMENT_LINK"]);

function hoursSinceLastContact(prior: Attempt[], clock: Clock): number | null {
  const contacts = prior.filter((a) => OUTREACH.has(a.action) && a.status !== "SKIPPED");
  const last = contacts.at(-1);
  if (!last) return null;
  return (clock.now().getTime() - Date.parse(last.createdAt)) / 3_600_000;
}

// Named for what the gate actually paces: the last time Razorpay was genuinely called. An
// ESCALATE or WRITE_OFF attempt never touched the bank and must not arm the charge cooldown —
// it used to, via a filter that only checked SKIPPED and let ESCALATE through as if it were one.
function hoursSinceLastAttempt(prior: Attempt[], clock: Clock): number | null {
  const moneyMoves = prior.filter((a) => MOVES_MONEY.has(a.action) && a.status !== "SKIPPED");
  const last = moneyMoves.at(-1);
  if (!last) return null;
  return (clock.now().getTime() - Date.parse(last.createdAt)) / 3_600_000;
}

export function buildGateContext(
  kase: RecoveryCase,
  proposal: AgentProposal,
  prior: Attempt[],
  attemptNo: number,
  directive: HumanDirective | null,
  clock: Clock,
  riskHoldForCase: ((kase: RecoveryCase) => boolean) | undefined,
  hardDeclineForCase: ((kase: RecoveryCase) => boolean) | undefined,
): GateContext {
  return {
    case: kase,
    attemptNo,
    humanAuthorization: directive ? { approver: directive.approver, at: directive.at } : null,
    hoursSinceLastAttempt: hoursSinceLastAttempt(prior, clock),
    hoursSinceLastContact: hoursSinceLastContact(prior, clock),
    riskHold: proposal.diagnosisRootCause === "risk_hold" || (riskHoldForCase?.(kase) ?? false),
    hardDecline: proposal.diagnosisRootCause === "hard_decline" || (hardDeclineForCase?.(kase) ?? false),
    unrecoverableDiagnosis: proposal.diagnosisRootCause === "unrecoverable",
    // A degraded loop already fell back to the safe action; its zero confidence is a missing
    // diagnosis, not a weak one, and clamping it to ESCALATE would defeat degrade-to-safe.
    confidence: proposal.degraded ? 1 : proposal.confidence,
    now: clock.now(),
  };
}
