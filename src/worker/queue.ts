import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";

export const RECOVERY_QUEUE = "recovery";

export type RecoveryJob = { caseId: string };

export function redisConnection(url: string): ConnectionOptions {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function recoveryQueue(connection: ConnectionOptions): Queue<RecoveryJob> {
  return new Queue<RecoveryJob>(RECOVERY_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 4,
      backoff: { type: "exponential", delay: 10_000 },
      // Drop completed jobs immediately so a case can be re-queued later; keeping the id in the
      // completed set would make jobId-based dedup permanently block the next run.
      removeOnComplete: true,
      removeOnFail: 200,
    },
  });
}

// One job per case at a time: while a job for this case is waiting, delayed or active, a second
// add with the same id is a no-op. This is what stops two concurrent turns for one case.
export async function enqueueRecovery(
  queue: Queue<RecoveryJob>,
  caseId: string,
  opts: { delay?: number } = {},
): Promise<void> {
  await queue.add(RECOVERY_QUEUE, { caseId }, { jobId: caseId, delay: opts.delay });
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
