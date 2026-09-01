import { z } from "zod";

export const rootCause = z.enum([
  "hard_decline",
  "insufficient_funds",
  "bank_downtime",
  "soft_decline",
  "risk_hold",
  "technical",
  "unrecoverable",
]);

export type RootCause = z.infer<typeof rootCause>;

export const diagnosis = z.object({
  rootCause,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export type Diagnosis = z.infer<typeof diagnosis>;
