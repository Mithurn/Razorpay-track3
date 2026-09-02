import type { RecoveryCase, Lane } from "./case.js";
import type { RecoveryEvent, StoredEvent } from "./events.js";

// Ports the infrastructure adapters implement. Nothing here knows about pg, Razorpay or BullMQ.

export interface EventLog {
  append(event: RecoveryEvent): Promise<void>;
  forCase(caseId: string): Promise<StoredEvent[]>;
}

export type NewCase = Omit<RecoveryCase, "lane" | "recoveredPaise">;

export interface CaseRepository {
  create(newCase: NewCase): Promise<RecoveryCase>;
  byId(id: string): Promise<RecoveryCase | null>;
  listByRun(runId: string): Promise<RecoveryCase[]>;
  /** Compare-and-set. Returns false if the row was not in `from` — the caller re-reads. */
  moveLane(id: string, from: Lane, to: Lane): Promise<boolean>;
  /** The only path that may raise recovered_paise, and only from a settled capture. */
  recordCapture(id: string, capturedPaise: number): Promise<void>;
}
