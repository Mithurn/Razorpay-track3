import type { RecoveryCase, Lane } from "./case.js";
import type { RecoveryEvent, StoredEvent } from "./events.js";
import type { Attempt, AttemptRequest, AttemptStatus } from "./attempt.js";
import type { RecoveryAction } from "./recovery-action.js";

// Ports the infrastructure adapters implement. Nothing here knows about pg, Razorpay or BullMQ.

export interface EventLog {
  append(event: RecoveryEvent): Promise<void>;
  forCase(caseId: string): Promise<StoredEvent[]>;
}

/**
 * Outbound customer contact. The one port with no real adapter in this build: CUSTOMER_NUDGE
 * records that a message was queued and returns a reference, but nothing is delivered. Kept as a
 * port rather than an inline no-op so the seam a WhatsApp/email provider plugs into is explicit,
 * and so the executor cannot silently do nothing — see LoggingNotifier.
 */
export interface NotificationPort {
  send(input: {
    caseId: string;
    channel: "email" | "sms";
    amountPaise: number;
    currency: string;
  }): Promise<{ messageRef: string; delivered: boolean }>;
}

/**
 * Hands a case back to the worker for another turn. A port so the adapter layers never hold a
 * queue type: the webhook handler ingests a failed payment and needs it worked, but has no
 * business knowing BullMQ exists.
 */
export interface CaseEnqueuer {
  enqueue(caseId: string, opts?: { delay?: number }): Promise<void>;
}

export interface WebhookInbox {
  /** Returns false when this Razorpay event id was already recorded — a duplicate delivery. */
  recordIfNew(eventId: string, event: string, payload: unknown): Promise<boolean>;
}

export interface AttemptRepository {
  /** Find the attempt that created this Razorpay order or payment-link id. */
  byRazorpayRef(ref: string): Promise<Attempt | null>;
  /**
   * Insert-or-return: the idempotency key is unique, so a concurrent claim gets the existing
   * row. `created` is true only for the caller whose insert actually landed — the only caller
   * allowed to perform the Razorpay call.
   */
  claim(request: AttemptRequest, idempotencyKey: string): Promise<{ attempt: Attempt; created: boolean }>;
  byId(id: string): Promise<Attempt | null>;
  byCaseAndNo(caseId: string, attemptNo: number): Promise<Attempt | null>;
  listByCase(caseId: string): Promise<Attempt[]>;
  recordRazorpayRef(id: string, ref: string): Promise<void>;
  /** For non-recovery ends (failed, escalated, awaiting reconciliation). Never moves money. */
  resolve(id: string, patch: { status: Exclude<AttemptStatus, "RECOVERED">; detail?: string | null }): Promise<void>;
  /**
   * The one path that raises a case's recovered_paise. Atomic: settles the attempt and adds the
   * captured amount to the case in a single statement, guarded so a re-settle is a no-op.
   * Returns true only on the transition that actually moved the money.
   */
  settleRecovered(id: string, capturedPaise: number, paymentId: string): Promise<boolean>;
  listUnsettled(): Promise<Attempt[]>;
}

/**
 * How an attempt's payment result is determined once the order or link exists. Real against
 * Razorpay for the live lane; ground-truth for the eval. Same interface, so the executor,
 * the gate and the ledger cannot tell which is running.
 */
export interface OutcomeResolver {
  resolve(input: {
    caseId: string;
    action: RecoveryAction;
    razorpayRef: string | null;
    amountPaise: number;
  }): Promise<OutcomeVerdict>;
}

export type OutcomeVerdict =
  | { kind: "recovered"; capturedPaise: number; paymentId: string }
  | { kind: "failed"; detail: string }
  | { kind: "pending" };

export type NewCase = Omit<RecoveryCase, "lane" | "recoveredPaise" | "method" | "instrument"> & {
  method?: string | null;
  instrument?: Record<string, string> | null;
  groundTruth?: Record<string, unknown> | null;
};

export type SimilarCaseSummary = {
  failureReason: string;
  action: string;
  outcome: string;
  hoursToResolution: number | null;
};

export type RoomMetrics = {
  // Total across both buckets below — live cases only, never a projection.
  recoveredPaise: number;
  // A real Razorpay capture. The only figure shown as "recovered" without qualification.
  recoveredLivePaise: number;
  // Bench/demo settlement — never touched Razorpay. Always shown labelled as simulated.
  recoveredSimulatedPaise: number;
  // Money still in play: amountPaise of live cases not yet in a terminal lane. Not a claim about
  // how much of it is recoverable — there is no live ground truth to honestly say that.
  exposurePaise: number;
  liveCases: number;
  byLane: Partial<Record<Lane, number>>;
};

export interface CaseRepository {
  create(newCase: NewCase): Promise<RecoveryCase>;
  byId(id: string): Promise<RecoveryCase | null>;
  byOriginalPaymentId(paymentId: string): Promise<RecoveryCase | null>;
  listByRun(runId: string): Promise<RecoveryCase[]>;
  listLive(): Promise<RecoveryCase[]>;
  listByLane(lane: Lane): Promise<RecoveryCase[]>;
  /** Live cases stuck in `lane` since before the cutoff — a worker that died mid-turn leaves one. */
  listStaleInLane(lane: Lane, olderThan: Date): Promise<RecoveryCase[]>;
  /**
   * How cases with this failure reason actually ended: the last settled attempt of each already
   * resolved case, its action and outcome. Scoped to the same run (null run = live lane) and to
   * cases that failed strictly before `beforeFailedAt`, so the eval cannot peek forward.
   */
  similarResolved(
    failureReason: string,
    opts: { method: string | null; beforeFailedAt: string; runId: string | null; limit: number },
  ): Promise<SimilarCaseSummary[]>;
  /** Compare-and-set. Returns false if the row was not in `from` — the caller re-reads. */
  moveLane(id: string, from: Lane, to: Lane): Promise<boolean>;
  /** Room-wide totals over live cases (run_id IS NULL), for the top-bar / room-level view. */
  metrics(): Promise<RoomMetrics>;
}
