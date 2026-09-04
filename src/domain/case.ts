import { z } from "zod";

export const lane = z.enum([
  "INCOMING",
  "DIAGNOSING",
  "DECIDING",
  "ATTEMPTING",
  "RECOVERED",
  "RETRY_SCHEDULED",
  "ESCALATED",
  "WRITTEN_OFF",
  "STOPPED",
]);
export type Lane = z.infer<typeof lane>;

export const TERMINAL_LANES: readonly Lane[] = ["RECOVERED", "ESCALATED", "WRITTEN_OFF", "STOPPED"];
export const IN_FLIGHT_LANES: readonly Lane[] = ["DIAGNOSING", "DECIDING", "ATTEMPTING"];

export const customerPayment = z.object({
  paidAt: z.string().datetime(),
  amountPaise: z.number().int().nonnegative(),
  method: z.string(),
  status: z.enum(["captured", "failed"]),
});
export type CustomerPayment = z.infer<typeof customerPayment>;

export const recoveryCase = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  merchantRef: z.string(),
  customerRef: z.string(),
  originalPaymentId: z.string().nullable(),
  amountPaise: z.number().int().positive(),
  currency: z.string().default("INR"),
  failureCode: z.string(),
  failureReason: z.string(),
  failedAt: z.string().datetime(),
  method: z.string().nullable().default(null),
  instrument: z.record(z.string()).nullable().default(null),
  customerHistory: z.array(customerPayment),
  lane,
  recoveredPaise: z.number().int().nonnegative(),
});
export type RecoveryCase = z.infer<typeof recoveryCase>;

// The gate's risk_hold veto reads this directly from the case, never from the agent's diagnosis.
export const RISK_CHECK_FAILURE_REASON = "payment_risk_check_failed";

export function isRiskHold(kase: RecoveryCase): boolean {
  return kase.failureReason === RISK_CHECK_FAILURE_REASON;
}

// Card-itself declines — an automatic reattempt is what card networks fine merchants for.
const HARD_DECLINE_FAILURE_REASONS: ReadonlySet<string> = new Set(["card_expired"]);

export function isHardDecline(kase: RecoveryCase): boolean {
  return HARD_DECLINE_FAILURE_REASONS.has(kase.failureReason);
}
