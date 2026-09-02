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
]);
export type Lane = z.infer<typeof lane>;

export const TERMINAL_LANES: readonly Lane[] = ["RECOVERED", "ESCALATED", "WRITTEN_OFF"];

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
