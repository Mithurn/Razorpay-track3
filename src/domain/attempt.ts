import type { RecoveryAction } from "./recovery-action.js";
import type { RootCause } from "./failure.js";

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type AttemptStatus = "PENDING" | "RECOVERED" | "FAILED" | "SKIPPED" | "AWAITING_RECONCILIATION";

export type AttemptRequest = {
  caseId: string;
  attemptNo: number;
  rootCause: RootCause;
  action: RecoveryAction;
  reasoning: string;
  amountPaise: number;
  currency: string;
  scheduledFor: string | null;
  clamp: { reason: string } | null;
  /** The clock the caller is operating on — real wall time live, a simulated clock in bench. */
  createdAt: string;
};

export type Attempt = {
  id: string;
  caseId: string;
  attemptNo: number;
  action: RecoveryAction["kind"];
  idempotencyKey: string;
  razorpayRef: string | null;
  settledPaymentId: string | null;
  status: AttemptStatus;
  detail: string | null;
  recoveredPaise: number;
  createdAt: string;
};

/** One attempt = one idempotency key. Stable across worker retries so a crash never doubles up. */
export function idempotencyKeyFor(caseId: string, attemptNo: number): string {
  return `${caseId}:${attemptNo}`;
}
