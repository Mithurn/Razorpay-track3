import type { AgentRunner } from "../src/worker/pipeline.js";

// The baseline every recovery product ships by default: retry on day 1, then 3, 5, 7. No
// diagnosis, no downtime awareness, no rail switch, no nudge. Runs through the same gate,
// executor and ledger as the agent so the comparison is like for like.

const SCHEDULE_HOURS = [24, 48, 48, 48];

export const fixedScheduleRunner: AgentRunner = async (deps) => {
  const attemptNo = deps.priorAttempts.filter((a) => a.status !== "SKIPPED").length;
  const atHoursFromNow = SCHEDULE_HOURS[Math.min(attemptNo, SCHEDULE_HOURS.length - 1)]!;
  return {
    action: { kind: "RETRY_SCHEDULED", atHoursFromNow },
    diagnosisRootCause: null,
    confidence: 0,
    reasoning: `fixed schedule: retry ${atHoursFromNow}h after the previous attempt`,
    toolCalls: 0,
    degraded: false,
  };
};
