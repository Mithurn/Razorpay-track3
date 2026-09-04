import type { RecoveryCase, Lane } from "./case.js";
import type { RecoveryEvent, StoredEvent } from "./events.js";
import type { Attempt, AttemptRequest, AttemptStatus } from "./attempt.js";
import type { RecoveryAction } from "./recovery-action.js";

export interface EventLog {
  append(event: RecoveryEvent): Promise<void>;
  forCase(caseId: string): Promise<StoredEvent[]>;
}

// The one port with no real adapter in this build — see LoggingNotifier.
export interface NotificationPort {
  send(input: {
    caseId: string;
    channel: "email" | "sms";
    amountPaise: number;
    currency: string;
  }): Promise<{ messageRef: string; delivered: boolean }>;
}

export interface CaseEnqueuer {
  enqueue(caseId: string, opts?: { delay?: number }): Promise<void>;
}

export interface WebhookInbox {
  recordIfNew(eventId: string, event: string, payload: unknown): Promise<boolean>;
}

export interface AttemptRepository {
  byRazorpayRef(ref: string): Promise<Attempt | null>;
  // `created` is true only for the caller whose insert actually landed — the only one allowed
  // to call Razorpay.
  claim(request: AttemptRequest, idempotencyKey: string): Promise<{ attempt: Attempt; created: boolean }>;
  byId(id: string): Promise<Attempt | null>;
  listByCase(caseId: string): Promise<Attempt[]>;
  payableAttempt(caseId: string): Promise<Attempt | null>;
  recordRazorpayRef(id: string, ref: string): Promise<void>;
  resolve(id: string, patch: { status: Exclude<AttemptStatus, "RECOVERED">; detail?: string | null }): Promise<void>;
  // Atomic: settles the attempt and credits the case in one statement, guarded against a re-settle.
  settleRecovered(id: string, capturedPaise: number, paymentId: string): Promise<boolean>;
  listUnsettled(): Promise<Attempt[]>;
  // Returns null without running `fn` if another caller already holds the lock.
  withReperformLock<T>(attemptId: string, fn: () => Promise<T>): Promise<T | null>;
}

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
  recoveredPaise: number;
  recoveredLivePaise: number;
  // Bench/demo settlement — never touched Razorpay.
  recoveredSimulatedPaise: number;
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
  listStaleInLane(lane: Lane, olderThan: Date): Promise<RecoveryCase[]>;
  // Scoped to before `beforeFailedAt` so the eval cannot peek forward.
  similarResolved(
    failureReason: string,
    opts: { method: string | null; beforeFailedAt: string; runId: string | null; limit: number },
  ): Promise<SimilarCaseSummary[]>;
  moveLane(id: string, from: Lane, to: Lane): Promise<boolean>;
  metrics(): Promise<RoomMetrics>;
}
