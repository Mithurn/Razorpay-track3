import { z } from "zod";

/**
 * The root cause of a failed payment, as diagnosed by the recovery agent.
 * This is the only structured judgement the LLM produces; everything downstream
 * (the recovery strategy, the safety limits) is deterministic.
 */
export const rootCause = z.enum([
  "hard_decline", //       card dead / lost / stolen / expired — a retry is pointless
  "insufficient_funds", // retry timed near the customer's historical success window
  "bank_downtime", //      issuer in a known downtime window — wait, then retry
  "soft_decline", //       transient issuer/gateway decline — one retry soon
  "risk_hold", //          risk/fraud flag — must escalate, never auto-retry
  "technical", //          gateway/server error — immediate retry is fine
  "unrecoverable", //      repeated hard declines / budget exhausted — stop
]);

export type RootCause = z.infer<typeof rootCause>;

/** The agent's diagnosis, validated at the LLM boundary. */
export const diagnosis = z.object({
  rootCause,
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(2000),
});

export type Diagnosis = z.infer<typeof diagnosis>;
