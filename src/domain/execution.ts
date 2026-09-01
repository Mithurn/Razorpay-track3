export type ExecutionState =
  | "PENDING"
  | "ORDER_CREATED"
  | "AWAITING_PAYMENT"
  | "CAPTURING"
  | "AWAITING_RECONCILIATION"
  | "CAPTURED"
  | "FAILED";

export const TERMINAL_STATES: readonly ExecutionState[] = ["CAPTURED", "FAILED"];

export const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  PENDING: ["ORDER_CREATED", "FAILED"],
  ORDER_CREATED: ["AWAITING_PAYMENT", "FAILED"],
  AWAITING_PAYMENT: ["CAPTURING", "CAPTURED", "AWAITING_RECONCILIATION", "FAILED"],
  CAPTURING: ["CAPTURED", "AWAITING_RECONCILIATION", "FAILED"],
  AWAITING_RECONCILIATION: ["CAPTURED", "FAILED", "AWAITING_PAYMENT"],
  CAPTURED: [],
  FAILED: [],
};

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return TRANSITIONS[from].includes(to);
}

// Reverse view of TRANSITIONS, derived so the two maps cannot drift. The store enforces
// this atomically in SQL against the live row, so a stale in-memory snapshot can never
// smuggle in an invalid transition.
export const VALID_FROM: Record<ExecutionState, readonly ExecutionState[]> = Object.fromEntries(
  (Object.keys(TRANSITIONS) as ExecutionState[]).map((to) => [
    to,
    (Object.keys(TRANSITIONS) as ExecutionState[]).filter((from) => canTransition(from, to)),
  ]),
) as unknown as Record<ExecutionState, readonly ExecutionState[]>;

export function isTerminal(state: ExecutionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export type ExecutionEventType =
  | "JOB_CREATED"
  | "ORDER_CREATED"
  | "PAYMENT_AUTHORIZED"
  | "CAPTURE_ATTEMPTED"
  | "CAPTURED"
  | "CAPTURE_UNKNOWN"
  | "FAILED"
  | "WEBHOOK_RECEIVED"
  | "WEBHOOK_DUPLICATE"
  | "WEBHOOK_BAD_SIGNATURE"
  | "RECONCILED"
  | "MANIFEST";

export type ExecutionEvent = {
  event: ExecutionEventType;
  state: ExecutionState | null;
  razorpayRef: string | null;
  payload: unknown;
};
