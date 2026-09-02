export type Lane =
  | "INCOMING"
  | "DIAGNOSING"
  | "DECIDING"
  | "ATTEMPTING"
  | "RECOVERED"
  | "RETRY_SCHEDULED"
  | "ESCALATED"
  | "WRITTEN_OFF";

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

export type StreamEvent =
  | { type: "open"; caseId: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; name: string }
  | ToolResultEvent
  | ProposalEvent
  | AuditEvent
  | { type: "attempt"; status: string; recoveredPaise: number }
  | { type: "lane"; lane: string }
  | { type: "done"; lane: string };

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
};
