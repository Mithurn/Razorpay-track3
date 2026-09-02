import type { Queue } from "bullmq";
import type { RecoveryPipeline } from "./pipeline.js";
import type { RecoveryJob } from "./queue.js";
import { RECOVERY_QUEUE } from "./queue.js";
import type { CaseEventBus } from "../api/event-bus.js";

// Turns one pipeline outcome into the next queued job and streams the turn to any watchers. The
// pipeline holds the decisions; this only schedules and forwards.

export function makeProcessor(pipeline: RecoveryPipeline, queue: Queue<RecoveryJob>, bus: CaseEventBus) {
  return async function process(job: RecoveryJob): Promise<void> {
    const { caseId } = job;
    const outcome = await pipeline.advance(caseId, {
      onReasoningDelta: (text) => bus.publish(caseId, { type: "reasoning", text }),
      onToolCall: (name) => bus.publish(caseId, { type: "tool", name }),
      onFinding: (text) => bus.publish(caseId, { type: "finding", text }),
      onConcluded: (p) => {
        // The model may stream little prose between tool calls; always surface the final rationale.
        bus.publish(caseId, { type: "reasoning", text: `\n\n${p.reasoning}` });
        bus.publish(caseId, {
          type: "proposal",
          rootCause: p.diagnosisRootCause,
          action: p.action.kind,
          degraded: p.degraded,
        });
      },
    });

    if (outcome.kind === "resolved") {
      bus.publish(caseId, { type: "done", lane: outcome.lane });
      return;
    }
    await queue.add(RECOVERY_QUEUE, { caseId }, { delay: outcome.delayMs });
  };
}

export async function enqueueCase(queue: Queue<RecoveryJob>, caseId: string, delayMs = 0): Promise<void> {
  await queue.add(RECOVERY_QUEUE, { caseId }, { delay: delayMs });
}
