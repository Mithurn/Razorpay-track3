import { z } from "zod";
import type { EventLog } from "../domain/ports.js";
import type { Attempt } from "../domain/attempt.js";
import type { AgentProposal, RecoveryAction } from "../domain/recovery-action.js";
import { recoveryAction } from "../domain/recovery-action.js";

// What a human chose on an escalated case. Parsed out of the append-only log, so it is validated
// at the boundary like any other external input — a hand-written event row is untrusted.
export const humanDirective = z.object({
  action: recoveryAction,
  approver: z.string().min(1),
  at: z.string().datetime(),
  note: z.string().max(500).nullable().optional(),
});
export type HumanDirective = z.infer<typeof humanDirective>;

export function directedProposal(d: HumanDirective): AgentProposal {
  return {
    action: d.action,
    // No model ran, so there is no diagnosis to record and no confidence to score. Full
    // confidence only so the gate's model-confidence floor does not apply to a human's decision.
    diagnosisRootCause: null,
    confidence: 1,
    reasoning: `Directed by ${d.approver} on an escalated case${d.note ? `: ${d.note}` : "."}`,
    toolCalls: 0,
    degraded: false,
  };
}

// Newest human directive no attempt has acted on yet. Read from the append-only log, not a
// mutable column: the authorization is an audit fact first, the pipeline input second.
export async function pendingDirective(
  events: EventLog,
  caseId: string,
  prior: Attempt[],
): Promise<HumanDirective | null> {
  const recorded = await events.forCase(caseId);
  const latest = recorded.filter((e) => e.type === "HUMAN_DIRECTIVE").at(-1);
  if (!latest) return null;
  const parsed = humanDirective.safeParse(latest.payload);
  if (!parsed.success) return null;
  const actedSince = prior.some((a) => Date.parse(a.createdAt) > Date.parse(latest.createdAt));
  return actedSince ? null : parsed.data;
}

// The demo authenticates with one shared bearer token, so there is no per-person identity to
// record. Named plainly rather than invented: a real deployment puts the signed-in reviewer here.
export const SHARED_TOKEN_APPROVER = "demo-operator (shared token)";

export function directedAction(decision: {
  decision: "approve" | "redirect" | "write_off";
  redirectTo?: "RETRY_NOW" | "PAYMENT_LINK" | "CUSTOMER_NUDGE";
}): RecoveryAction {
  const kind = decision.decision === "approve" ? "RETRY_NOW" : (decision.redirectTo ?? "RETRY_NOW");
  if (kind === "PAYMENT_LINK") return { kind, rail: "card" };
  if (kind === "CUSTOMER_NUDGE") return { kind, channel: "email" };
  return { kind: "RETRY_NOW" };
}
