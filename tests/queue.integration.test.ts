import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { enqueueRecovery, type RecoveryJob } from "../src/worker/queue.js";

const redisUrl = process.env.REDIS_URL;
const QUEUE_NAME = `recovery-test-${randomUUID().slice(0, 8)}`;

describe.runIf(redisUrl)("recovery queue dedupe", () => {
  let connection: Redis;
  let queue: Queue<RecoveryJob>;
  let worker: Worker<RecoveryJob>;

  beforeAll(async () => {
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  });

  afterEach(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
  });

  afterAll(async () => {
    await connection.quit();
  });

  it("runs a turn enqueued while another for the same case is active, instead of dropping it", async () => {
    queue = new Queue<RecoveryJob>(QUEUE_NAME, {
      connection,
      defaultJobOptions: { removeOnComplete: true, removeOnFail: 200 },
    });
    const caseId = randomUUID();
    const processed: string[] = [];
    let release: () => void = () => undefined;
    const firstTurnHeld = new Promise<void>((resolve) => (release = resolve));

    worker = new Worker<RecoveryJob>(
      QUEUE_NAME,
      async (job) => {
        processed.push(job.data.caseId);
        if (processed.length === 1) await firstTurnHeld;
      },
      { connection },
    );
    await worker.waitUntilReady();

    await enqueueRecovery(queue, caseId);
    await waitFor(() => processed.length === 1);

    await enqueueRecovery(queue, caseId);

    release();
    await waitFor(() => processed.length === 2);
    expect(processed).toEqual([caseId, caseId]);
  }, 15_000);
});

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("condition not met within timeout");
}
