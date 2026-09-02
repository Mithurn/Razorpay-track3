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
      removeOnComplete: 500,
      removeOnFail: 500,
    },
  });
}

export function recoveryWorker(
  connection: ConnectionOptions,
  process: (job: RecoveryJob) => Promise<void>,
): Worker<RecoveryJob> {
  return new Worker<RecoveryJob>(RECOVERY_QUEUE, async (job) => process(job.data), {
    connection,
    concurrency: 10,
  });
}
