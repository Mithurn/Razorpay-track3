import { z } from "zod";

export const recoveryEventType = z.enum([
  "CASE_CREATED",
  "CASE_LANE_CHANGED",
  "INVESTIGATION_STARTED",
  "TOOL_CALLED",
  "TOOL_RESULT",
  "AGENT_PROPOSED",
  "AGENT_DEGRADED",
  "GATE_APPLIED",
  "ATTEMPT_STARTED",
  "ATTEMPT_OUTCOME",
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
