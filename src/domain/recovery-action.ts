import { z } from "zod";
import type { RootCause } from "./failure.js";

export const recoveryAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RETRY_NOW") }),
  z.object({ kind: z.literal("RETRY_SCHEDULED"), atHoursFromNow: z.number().positive().max(720) }),
  // No upi rail: Razorpay does not support UPI payment links in test mode.
  z.object({ kind: z.literal("PAYMENT_LINK"), rail: z.enum(["card", "netbanking"]) }),
  z.object({ kind: z.literal("CUSTOMER_NUDGE"), channel: z.enum(["email", "sms"]) }),
  z.object({ kind: z.literal("ESCALATE"), reason: z.string().min(1) }),
  z.object({ kind: z.literal("WRITE_OFF"), reason: z.string().min(1) }),
]);

export type RecoveryAction = z.infer<typeof recoveryAction>;

export type AgentProposal = {
  action: RecoveryAction;
  // null when the loop degraded to a safe fallback without reaching a diagnosis — never guessed.
  diagnosisRootCause: RootCause | null;
  confidence: number;
  reasoning: string;
  toolCalls: number;
  degraded: boolean;
};

/**
 * The three actions that actually touch Razorpay. Everything that reasons about pacing —
 * the exposure cap, the confidence floor, the retry cooldown — means "since the last one of
 * these", never "since the last attempt of any kind." An ESCALATE or WRITE_OFF attempt is a
 * record that no money moved; it must not reset a cooldown meant to pace charges against a bank.
 */
export const MOVES_MONEY: ReadonlySet<RecoveryAction["kind"]> = new Set([
  "RETRY_NOW",
  "RETRY_SCHEDULED",
  "PAYMENT_LINK",
]);

// The safety gate may move an action up this ladder, never down.
export const CAUTION_RANK: Record<RecoveryAction["kind"], number> = {
  RETRY_NOW: 0,
  RETRY_SCHEDULED: 1,
  PAYMENT_LINK: 1,
  CUSTOMER_NUDGE: 2,
  ESCALATE: 3,
  WRITE_OFF: 3,
};
