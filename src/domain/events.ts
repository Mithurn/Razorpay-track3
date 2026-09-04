import { z } from "zod";

export const recoveryEventType = z.enum([
  "CASE_CREATED",
  "CASE_LANE_CHANGED",
  "INVESTIGATION_STARTED",
  "TOOL_CALLED",
  "TOOL_RESULT",
  "AUDIT_GAP",
  "AGENT_PROPOSED",
  "AGENT_DEGRADED",
  // A human resolved an escalation. Durable because it is both an audit fact and the input the
  // next pipeline turn reads to know what the human actually decided.
  "HUMAN_DIRECTIVE",
  "AGENT_SKIPPED_HUMAN_DIRECTED",
  "GATE_APPLIED",
  "ATTEMPT_STARTED",
  "ATTEMPT_REPERFORMED",
  "ATTEMPT_OUTCOME",
  "NUDGE_QUEUED",
  "CASE_RESOLVED",
  "CASE_STOPPED",
]);
export type RecoveryEventType = z.infer<typeof recoveryEventType>;

export type RecoveryEvent = {
  caseId: string;
  type: RecoveryEventType;
  payload: Record<string, unknown>;
};

export type StoredEvent = RecoveryEvent & {
  id: string;
  createdAt: string;
};
