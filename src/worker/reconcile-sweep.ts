import type { AttemptRepository, CaseRepository } from "../domain/ports.js";
import type { Queue } from "bullmq";
import type { RecoveryJob } from "./queue.js";
import { enqueueRecovery } from "./queue.js";
import { TERMINAL_LANES } from "../domain/case.js";

// A safety net for attempts left PENDING or AWAITING_RECONCILIATION when their scheduled job
// never fired (a worker died between settling and enqueueing). Re-queues the owning case so
// pipeline.advance settles it. Idempotent — a case already terminal is skipped.

export function startReconcileSweep(
  attempts: AttemptRepository,
  cases: CaseRepository,
  queue: Queue<RecoveryJob>,
  intervalMs = 5 * 60_000,
): { stop: () => void } {
  const tick = async () => {
    const parked = await attempts.listUnsettled();
    const caseIds = [...new Set(parked.map((a) => a.caseId))];
    for (const caseId of caseIds) {
      const kase = await cases.byId(caseId);
      if (!kase || TERMINAL_LANES.includes(kase.lane)) continue;
      // jobId is the case id, so this is a no-op if a turn for the case is already queued.
      await enqueueRecovery(queue, caseId);
    }
  };

  const timer = setInterval(() => void tick().catch(() => undefined), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
