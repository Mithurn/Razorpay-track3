export type Lane =
  | "INCOMING"
  | "DIAGNOSING"
  | "DECIDING"
  | "ATTEMPTING"
  | "RECOVERED"
  | "RETRY_SCHEDULED"
  | "ESCALATED"
  | "WRITTEN_OFF"
  | "STOPPED";

export const RESOLVED_LANES: readonly Lane[] = ["RECOVERED", "ESCALATED", "WRITTEN_OFF", "STOPPED"];

export type RecoveryCase = {
  id: string;
  merchantRef: string;
  customerRef: string;
  amountPaise: number;
  currency: string;
  failureCode: string;
  failureReason: string;
  failedAt: string;
  method: string | null;
  instrument: Record<string, string> | null;
  customerHistory: { paidAt: string; amountPaise: number; method: string; status: string }[];
  lane: Lane;
  recoveredPaise: number;
};

export type StoredEvent = {
  id: string;
  caseId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type Attempt = {
  id: string;
  attemptNo: number;
  action: string;
  status: string;
  detail: string | null;
  recoveredPaise: number;
  razorpayRef: string | null;
  idempotencyKey: string;
  settledPaymentId: string | null;
};

export type CaseDetail = { case: RecoveryCase; attempts: Attempt[]; events: StoredEvent[] };

export type ToolSource = "local" | "razorpay-live";

export type ToolResultEvent = {
  type: "tool_result";
  name: string;
  source: ToolSource;
  raw: unknown;
  ms: number;
};

export type ProposalEvent = {
  type: "proposal";
  rootCause: string | null;
  action: string;
  degraded: boolean;
  confidence: number;
  toolCalls: number;
  reasoning: string;
};

export type AuditEvent = {
  type: "audit";
  eventType: string;
  payload: Record<string, unknown>;
  at: string;
};

export type DoneReason = "resolved" | "rescheduled" | "awaiting_settlement";

export type StreamEvent =
  | { type: "open"; caseId: string }
  | { type: "status"; lane: string; active: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool"; name: string }
  | ToolResultEvent
  | ProposalEvent
  | AuditEvent
  | { type: "done"; lane: string; reason: DoneReason };

export type RunSummary = {
  arm: string;
  cases: number;
  recovered: number;
  recoveryRate: number;
  recoveredPaise: number;
  recoverablePaise: number;
  meanAttemptsPerRecovery: number;
  meanHoursToRecovery: number;
  escalations: number;
  escalationRate: number;
  overNudges: number;
  overNudgeRate: number;
  // null for an arm that never diagnoses (fixed, rules).
  rootCauseAccuracy: number | null;
};

// GET /metrics — room-wide totals over live cases, computed fresh from recovery_cases. Never a
// "recoverable" or "lift" claim: there is no live control arm to honestly compare against.
export type RoomMetrics = {
  recoveredPaise: number;
  // A real Razorpay capture — the only figure shown as "recovered" unqualified.
  recoveredLivePaise: number;
  // Bench/demo settlement — never touched Razorpay, always shown labelled.
  recoveredSimulatedPaise: number;
  exposurePaise: number;
  liveCases: number;
  byLane: Partial<Record<Lane, number>>;
  braked: boolean;
};

// GET /stream — the room-wide feed: every durable event across every case, tagged with which
// case it belongs to. Opens with a metrics snapshot so a fresh subscriber renders immediately.
export type RoomStreamEvent =
  | { type: "open" }
  | ({ type: "metrics" } & RoomMetrics)
  | { type: "audit"; caseId: string; eventType: string; payload: Record<string, unknown>; at: string };
