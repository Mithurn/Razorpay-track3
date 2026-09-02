import type { Queue } from "bullmq";
import type { RecoveryPipeline } from "./pipeline.js";
import type { RecoveryJob } from "./queue.js";
import { enqueueRecovery } from "./queue.js";
import type { CaseEventBus } from "../api/event-bus.js";

// Turns one pipeline outcome into the next queued job and streams the turn to any watchers. The
// pipeline holds the decisions; this only schedules and forwards.

export function makeProcessor(pipeline: RecoveryPipeline, queue: Queue<RecoveryJob>, bus: CaseEventBus) {
  return async function process(job: RecoveryJob, meta: { attemptsMade?: number } = {}): Promise<void> {
    const { caseId } = job;
    const outcome = await pipeline.advance(
      caseId,
      {
        onReasoningDelta: (text) => bus.publish(caseId, { type: "reasoning", text }),
        onToolCall: (name) => bus.publish(caseId, { type: "tool", name }),
        onToolResult: (r) => bus.publish(caseId, { type: "tool_result", ...r }),
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
      { reclaim: (meta.attemptsMade ?? 0) > 0 },
    );

    if (outcome.kind === "not_claimed") return;
    if (outcome.kind === "resolved") {
      bus.publish(caseId, { type: "done", lane: outcome.lane });
      return;
    }
    await enqueueRecovery(queue, caseId, { delay: outcome.delayMs });
  };
}
