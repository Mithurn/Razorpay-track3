import type { Queue } from "bullmq";
import type { RecoveryPipeline } from "./pipeline.js";
import type { RecoveryJob } from "./queue.js";
import { enqueueRecovery } from "./queue.js";
import type { CaseEventBus } from "../api/event-bus.js";
import type { EventLog } from "../domain/ports.js";

// Turns one pipeline outcome into the next queued job and streams the turn to any watchers. The
// pipeline holds the decisions; this only schedules and forwards.

export function makeProcessor(pipeline: RecoveryPipeline, queue: Queue<RecoveryJob>, bus: CaseEventBus, events: EventLog) {
  return async function process(job: RecoveryJob, meta: { attemptsMade?: number } = {}): Promise<void> {
    const { caseId, reclaim: forcedReclaim } = job;
    // Tool calls/results get two paths: an immediate bus signal for a responsive live UI, and a
    // durable append (which the bus mirrors as an `audit` event a moment later) so the tool
    // trace survives a restart and is part of the canonical event log, not just in-memory.
    // Awaited by the caller (recovery-agent.ts's tool wrapper), so a TOOL_CALLED row always
    // commits before its TOOL_RESULT — two unawaited appends can land on different pooled
    // connections and commit out of order.
    const persistToolEvent = (type: "TOOL_CALLED" | "TOOL_RESULT", payload: Record<string, unknown>) =>
      events
        .append({ caseId, type, payload: { ...payload, activity: "investigate" } })
        .catch((err) => console.error(`failed to persist ${type}:`, err));

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

    // Every exit that ends this turn tells the stream so, or a watching client waits forever on a
    // run that is no longer happening. `not_claimed` is the one exception: another job owns the
    // case and will publish its own ending.
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
