import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { RecoveryPipeline } from "../src/worker/pipeline.js";
import { makeProcessor } from "../src/worker/recovery-worker.js";
import { CaseEventBus } from "../src/api/event-bus.js";
import { RECOVERY_QUEUE, type RecoveryJob } from "../src/worker/queue.js";
import type { AgentProposal } from "../src/domain/recovery-action.js";
import type { OutcomeResolver, OutcomeVerdict } from "../src/domain/ports.js";
import type { GatewayOrder, GatewayPayment, GatewayPaymentLink, PaymentGateway } from "../src/domain/gateway.js";

const adminUrl = process.env.ADMIN_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

class FakeGateway implements PaymentGateway {
  orders = 0;
  async createOrder(i: { amountPaise: number }): Promise<GatewayOrder> {
    this.orders++;
    return { id: `order_e2e_${this.orders}`, amountPaise: i.amountPaise };
  }
  async createPaymentLink(i: { amountPaise: number }): Promise<GatewayPaymentLink> {
    return { id: "plink_e2e", url: "x", amountPaise: i.amountPaise };
  }
  async getPayment(): Promise<GatewayPayment | null> {
    return null;
  }
  async findOrderByIdempotencyKey(): Promise<GatewayOrder | null> {
    return null;
  }
  async findPaymentLinkByIdempotencyKey(): Promise<GatewayPaymentLink | null> {
    return null;
  }
  async listOrderPayments(): Promise<GatewayPayment[]> {
    return [];
  }
  async getPaymentLink() {
    return null;
  }
  async listDowntimes() {
    return [];
  }
}

describe.runIf(adminUrl && redisUrl)("recovery worker end to end", () => {
  let db: Db;
  let connection: Redis;
  let queue: Queue<RecoveryJob>;
  let worker: Worker<RecoveryJob>;
  let caseId: string;

  beforeAll(async () => {
    db = createPool(adminUrl!);
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
  });

  afterEach(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    if (caseId) {
      await db.query("DELETE FROM recovery_events WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_attempts WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_cases WHERE id = $1", [caseId]);
    }
  });

  afterAll(async () => {
    await connection.quit();
    await db.end();
  });

  it("takes a seeded failed payment from INCOMING to RECOVERED with a real ledger credit", async () => {
    caseId = randomUUID();
    await new PostgresCaseRepository(db).create({
      id: caseId,
      runId: null,
      merchantRef: "acme_subscriptions",
      customerRef: "cust_42",
      originalPaymentId: null,
      amountPaise: 149900,
      currency: "INR",
      failureCode: "BAD_REQUEST_ERROR",
      failureReason: "insufficient_funds",
      failedAt: new Date().toISOString(),
      method: "card",
      instrument: { issuer: "HDFC" },
      customerHistory: [
        { paidAt: "2026-06-01T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
        { paidAt: "2026-07-01T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
      ],
    });

    const proposal: AgentProposal = {
      action: { kind: "RETRY_SCHEDULED", atHoursFromNow: 1 / 3600 },
      diagnosisRootCause: "insufficient_funds",
      confidence: 0.72,
      reasoning: "two clean prior payments; time a retry for shortly after payday",
      toolCalls: 3,
      degraded: false,
    };

    const verdicts: OutcomeVerdict[] = [{ kind: "recovered", capturedPaise: 149900, paymentId: "pay_e2e_1" }];
    const resolver: OutcomeResolver = { resolve: async () => verdicts.shift() ?? { kind: "pending" } };

    const gateway = new FakeGateway();
    const pipeline = new RecoveryPipeline({
      cases: new PostgresCaseRepository(db),
      attempts: new PostgresAttemptRepository(db),
      events: new PostgresEventLog(db),
      gateway,
      outcomeResolver: resolver,
      clock: { now: () => new Date() },
      runAgent: async () => proposal,
    });

    queue = new Queue<RecoveryJob>(RECOVERY_QUEUE, { connection });
    worker = new Worker<RecoveryJob>(
      RECOVERY_QUEUE,
      async (job) => makeProcessor(pipeline, queue, new CaseEventBus())(job.data),
      { connection },
    );

    await queue.add(RECOVERY_QUEUE, { caseId });

    await viWaitFor(async () => {
      const kase = await new PostgresCaseRepository(db).byId(caseId);
      return kase?.lane === "RECOVERED";
    });

    const kase = await new PostgresCaseRepository(db).byId(caseId);
    expect(kase!.lane).toBe("RECOVERED");
    expect(kase!.recoveredPaise).toBe(149900);
    expect(gateway.orders).toBe(1);

    const events = (await new PostgresEventLog(db).forCase(caseId)).map((e) => e.type);
    expect(events).toEqual(
      expect.arrayContaining(["INVESTIGATION_STARTED", "AGENT_PROPOSED", "GATE_APPLIED", "ATTEMPT_OUTCOME", "CASE_RESOLVED"]),
    );
  }, 15_000);
});

async function viWaitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("condition not met within timeout");
}
