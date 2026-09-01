import { z } from "zod";

/**
 * A recovery move. The agent *proposes* one of these; the safety gate may only
 * substitute a more cautious one (never a less cautious one).
 */
export const recoveryAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RETRY_NOW") }),
  z.object({ kind: z.literal("RETRY_SCHEDULED"), atHoursFromNow: z.number().positive().max(720) }),
  z.object({ kind: z.literal("PAYMENT_LINK"), rail: z.enum(["upi", "card", "netbanking"]) }),
  z.object({ kind: z.literal("CUSTOMER_NUDGE"), channel: z.enum(["email", "sms"]) }),
  z.object({ kind: z.literal("ESCALATE"), reason: z.string().min(1) }),
  z.object({ kind: z.literal("WRITE_OFF"), reason: z.string().min(1) }),
]);

export type RecoveryAction = z.infer<typeof recoveryAction>;

/** What the agent hands back after a bounded investigation. */
export type AgentProposal = {
  action: RecoveryAction;
  diagnosisRootCause: import("./failure.js").RootCause;
  reasoning: string;
  toolCalls: number;
};

/**
 * Caution ordering. The safety gate can move an action UP this ladder, never down.
 * WRITE_OFF and ESCALATE are terminal (no money moves), so they rank highest.
 */
export const CAUTION_RANK: Record<RecoveryAction["kind"], number> = {
  RETRY_NOW: 0,
  RETRY_SCHEDULED: 1,
  PAYMENT_LINK: 1,
  CUSTOMER_NUDGE: 2,
  ESCALATE: 3,
  WRITE_OFF: 3,
};
