import type { Queue } from "bullmq";
import type { RecoveryPipeline } from "./pipeline.js";
import type { RecoveryJob } from "./queue.js";
import { enqueueRecovery } from "./queue.js";
import type { CaseEventBus } from "../api/event-bus.js";
import type { EventLog } from "../domain/ports.js";

export function makeProcessor(pipeline: RecoveryPipeline, queue: Queue<RecoveryJob>, bus: CaseEventBus, events: EventLog) {
  return async function process(job: RecoveryJob, meta: { attemptsMade?: number } = {}): Promise<void> {
    const { caseId, reclaim: forcedReclaim } = job;
    // Awaited so a TOOL_CALLED row always commits before its TOOL_RESULT, never out of order.
    const persistToolEvent = (type: "TOOL_CALLED" | "TOOL_RESULT", payload: Record<string, unknown>) =>
      events.append({ caseId, type, payload: { ...payload, activity: "investigate" } }).catch((err) => {
        console.error(`failed to persist ${type}:`, err);
        return events
          .append({ caseId, type: "AUDIT_GAP", payload: { lostEvent: type, activity: "investigate" } })
          .catch((gapErr) => console.error(`failed to record AUDIT_GAP after losing ${type}:`, gapErr));
      });

    const outcome = await pipeline.advance(
      caseId,
      {
        onReasoningDelta: (text) => bus.publish(caseId, { type: "reasoning", text }),
        onToolCall: async (call) => {
          bus.publish(caseId, { type: "tool", name: call.name });
          await persistToolEvent("TOOL_CALLED", { name: call.name, callId: call.callId, args: call.args });
        },
        onToolResult: async (r) => {
          bus.publish(caseId, { type: "tool_result", name: r.name, source: r.source, raw: r.raw, ms: r.ms });
          await persistToolEvent("TOOL_RESULT", { name: r.name, callId: r.callId, source: r.source, raw: r.raw, ms: r.ms });
        },
        onConcluded: (p) => {
          bus.publish(caseId, {
            type: "proposal",
            rootCause: p.diagnosisRootCause,
            action: p.action.kind,
            degraded: p.degraded,
            confidence: p.confidence,
            toolCalls: p.toolCalls,
            reasoning: p.reasoning,
          });
        },
      },
      { reclaim: forcedReclaim === true || (meta.attemptsMade ?? 0) > 0 },
    );

    // not_claimed: another job owns this case and will publish its own ending.
    if (outcome.kind === "not_claimed") return;
    if (outcome.kind === "resolved") {
      bus.publish(caseId, { type: "done", lane: outcome.lane, reason: "resolved" });
      return;
    }
    bus.publish(caseId, {
      type: "done",
      lane: outcome.kind === "reschedule" ? "RETRY_SCHEDULED" : "ATTEMPTING",
      reason: outcome.kind === "reschedule" ? "rescheduled" : "awaiting_settlement",
    });
    await enqueueRecovery(queue, caseId, { delay: outcome.delayMs });
  };
}
