import type { RecoveryCase, Lane } from "./case.js";
import type { RecoveryEvent, StoredEvent } from "./events.js";
import type { Attempt, AttemptRequest, AttemptStatus } from "./attempt.js";
import type { RecoveryAction } from "./recovery-action.js";

// Ports the infrastructure adapters implement. Nothing here knows about pg, Razorpay or BullMQ.

export interface EventLog {
  append(event: RecoveryEvent): Promise<void>;
  forCase(caseId: string): Promise<StoredEvent[]>;
}

export interface WebhookInbox {
  /** Returns false when this Razorpay event id was already recorded — a duplicate delivery. */
  recordIfNew(eventId: string, event: string, payload: unknown): Promise<boolean>;
}

export interface AttemptRepository {
  /** Find the attempt that created this Razorpay order or payment-link id. */
  byRazorpayRef(ref: string): Promise<Attempt | null>;
  /** Insert-or-return: the idempotency key is unique, so a retry gets the existing row. */
  claim(request: AttemptRequest, idempotencyKey: string): Promise<Attempt>;
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

export interface CaseRepository {
  create(newCase: NewCase): Promise<RecoveryCase>;
  byId(id: string): Promise<RecoveryCase | null>;
  listByRun(runId: string): Promise<RecoveryCase[]>;
  listLive(): Promise<RecoveryCase[]>;
  listByLane(lane: Lane): Promise<RecoveryCase[]>;
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
}
