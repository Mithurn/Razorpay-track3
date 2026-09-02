import type { OutcomeResolver, OutcomeVerdict } from "../src/domain/ports.js";
import type { RecoveryAction } from "../src/domain/recovery-action.js";
import type { Clock } from "../src/domain/attempt.js";
import type { GroundTruth, RecoveryFamily } from "./corpus.js";

// The bench lane's verdict. The order and payment link are still created for real (idempotency
// and the re-check path are genuinely exercised); only the authorization result is decided here,
// from the case's ground truth and the simulated clock.
//
// The `detail` on a failed verdict is deliberately flat ("payment declined") — a live Razorpay
// decline never tells you the recovery hour or the correct action, and this string is written to
// the attempt row that get_this_case_prior_attempts feeds back to the agent. Anything richer
// would leak the answer key.

const DECLINE_DETAIL = "payment declined";

const FAMILY: Record<RecoveryAction["kind"], RecoveryFamily | null> = {
  RETRY_NOW: "RETRY",
  RETRY_SCHEDULED: "RETRY",
  PAYMENT_LINK: "PAYMENT_LINK",
  CUSTOMER_NUDGE: "CUSTOMER_NUDGE",
  ESCALATE: null,
  WRITE_OFF: null,
};

const OUTREACH: ReadonlySet<RecoveryAction["kind"]> = new Set(["PAYMENT_LINK", "CUSTOMER_NUDGE"]);

export class GroundTruthResolver implements OutcomeResolver {
  private readonly recoveredAt = new Map<string, number>();

  constructor(
    private readonly truth: Map<string, GroundTruth>,
    private readonly clock: Clock,
    private readonly epoch: number,
  ) {}

  /** Sim hours from the failure to the capture, for the case's time-to-recovery. */
  recoveredAtHour(caseId: string): number | null {
    return this.recoveredAt.get(caseId) ?? null;
  }

  async resolve(input: {
    caseId: string;
    action: RecoveryAction;
    razorpayRef: string | null;
    amountPaise: number;
  }): Promise<OutcomeVerdict> {
    const gt = this.truth.get(input.caseId);
    if (!gt?.recoverable) return { kind: "failed", detail: DECLINE_DETAIL };

    const family = FAMILY[input.action.kind];
    if (family !== gt.via) return { kind: "failed", detail: DECLINE_DETAIL };

    const hour = this.settlesAtHour(input.action, gt);
    if (hour === null) return { kind: "failed", detail: DECLINE_DETAIL };

    this.recoveredAt.set(input.caseId, hour);
    return { kind: "recovered", capturedPaise: input.amountPaise, paymentId: `sim_${input.caseId}` };
  }

  // A charge is graded when it is presented, so a retry scheduled for +72h settles at +72h, not
  // at the hour it was decided. An outreach presents nothing — it asks, and the customer answers
  // at the hour the ground truth says they act.
  private settlesAtHour(action: RecoveryAction, gt: GroundTruth): number | null {
    const now = (this.clock.now().getTime() - this.epoch) / 3_600_000;
    if (OUTREACH.has(action.kind)) return Math.max(now, gt.atHour ?? now);

    const presentedAt = now + (action.kind === "RETRY_SCHEDULED" ? action.atHoursFromNow : 0);
    if (gt.atHour !== null && presentedAt + 1e-6 < gt.atHour) return null;
    return presentedAt;
  }
}
