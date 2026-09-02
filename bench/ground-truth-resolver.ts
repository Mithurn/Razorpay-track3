import type { OutcomeResolver, OutcomeVerdict } from "../src/domain/ports.js";
import type { RecoveryAction } from "../src/domain/recovery-action.js";
import type { Clock } from "../src/domain/attempt.js";
import type { GroundTruth, RecoveryFamily } from "./corpus.js";

// The bench lane's verdict. The order and payment link are still created for real (idempotency
// and the re-check path are genuinely exercised); only the authorization result is decided here,
// from the case's ground truth and the simulated clock.

const FAMILY: Record<RecoveryAction["kind"], RecoveryFamily | null> = {
  RETRY_NOW: "RETRY",
  RETRY_SCHEDULED: "RETRY",
  PAYMENT_LINK: "PAYMENT_LINK",
  CUSTOMER_NUDGE: "CUSTOMER_NUDGE",
  ESCALATE: null,
  WRITE_OFF: null,
};

export class GroundTruthResolver implements OutcomeResolver {
  constructor(
    private readonly truth: Map<string, GroundTruth>,
    private readonly clock: Clock,
    private readonly epoch: number,
  ) {}

  async resolve(input: {
    caseId: string;
    action: RecoveryAction;
    razorpayRef: string | null;
    amountPaise: number;
  }): Promise<OutcomeVerdict> {
    const gt = this.truth.get(input.caseId);
    if (!gt) return { kind: "failed", detail: "no ground truth" };
    if (!gt.recoverable) return { kind: "failed", detail: gt.note };

    const family = FAMILY[input.action.kind];
    if (family !== gt.via) return { kind: "failed", detail: `wrong action for this case (${gt.note})` };

    const simHours = (this.clock.now().getTime() - this.epoch) / 3_600_000;
    if (gt.atHour !== null && simHours + 1e-6 < gt.atHour) {
      return { kind: "failed", detail: `too early (recovers at +${gt.atHour}h)` };
    }
    return { kind: "recovered", capturedPaise: input.amountPaise, paymentId: `sim_${input.caseId}` };
  }
}
