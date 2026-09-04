import { z } from "zod";
import type { EventLog } from "../domain/ports.js";
import type { Attempt } from "../domain/attempt.js";
import type { AgentProposal, RecoveryAction } from "../domain/recovery-action.js";
import { recoveryAction } from "../domain/recovery-action.js";

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
    // Full confidence so the gate's model-confidence floor does not apply to a human's decision.
    diagnosisRootCause: null,
    confidence: 1,
    reasoning: `Directed by ${d.approver} on an escalated case${d.note ? `: ${d.note}` : "."}`,
    toolCalls: 0,
    degraded: false,
  };
}

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

// A real deployment puts the signed-in reviewer here; the demo authenticates with one shared token.
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
