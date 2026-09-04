import type { AttemptRepository, CaseRepository } from "../domain/ports.js";
import type { Queue } from "bullmq";
import type { RecoveryJob } from "./queue.js";
import { enqueueRecovery } from "./queue.js";
import { TERMINAL_LANES } from "../domain/case.js";

// `reclaim` lets the pipeline tell a stale DIAGNOSING case apart from one another worker still holds.
export function startReconcileSweep(
  attempts: AttemptRepository,
  cases: CaseRepository,
  queue: Queue<RecoveryJob>,
  intervalMs = 5 * 60_000,
): { stop: () => void } {
  const tick = async () => {
    const parked = await attempts.listUnsettled();
    for (const caseId of new Set(parked.map((a) => a.caseId))) {
      const kase = await cases.byId(caseId);
      if (!kase || TERMINAL_LANES.includes(kase.lane)) continue;
      await enqueueRecovery(queue, caseId);
    }

    const staleDiagnosing = await cases.listStaleInLane("DIAGNOSING", new Date(Date.now() - intervalMs));
    for (const kase of staleDiagnosing) {
      await enqueueRecovery(queue, kase.id, { reclaim: true });
    }
  };

  const timer = setInterval(() => void tick().catch((err) => console.error("reconcile-sweep tick failed:", err)), intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
