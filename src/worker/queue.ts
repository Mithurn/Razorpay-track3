import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";

export const RECOVERY_QUEUE = "recovery";

// reclaim: set only by the reconcile sweep, for a case orphaned in DIAGNOSING with no live job.
export type RecoveryJob = { caseId: string; reclaim?: boolean };

export function redisConnection(url: string): ConnectionOptions {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function recoveryQueue(connection: ConnectionOptions): Queue<RecoveryJob> {
  return new Queue<RecoveryJob>(RECOVERY_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 10_000 },
      // Keeping a completed job's id would make dedupe permanently block the next run.
      removeOnComplete: true,
      removeOnFail: 200,
    },
  });
}

// A duplicate id on an active job is stored and materialized as a new job once it finishes.
export async function enqueueRecovery(
  queue: Queue<RecoveryJob>,
  caseId: string,
  opts: { delay?: number; reclaim?: boolean } = {},
): Promise<void> {
  await queue.add(
    RECOVERY_QUEUE,
    { caseId, reclaim: opts.reclaim },
    { deduplication: { id: caseId, keepLastIfActive: true }, delay: opts.delay },
  );
}

export function recoveryWorker(
  connection: ConnectionOptions,
  process: (job: RecoveryJob, meta: { attemptsMade: number }) => Promise<void>,
): Worker<RecoveryJob> {
  return new Worker<RecoveryJob>(RECOVERY_QUEUE, async (job) => process(job.data, { attemptsMade: job.attemptsMade }), {
    connection,
    concurrency: 10,
  });
}
