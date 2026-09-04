import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { PostgresWebhookInbox } from "../src/persistence/webhook-inbox.js";
import { AttemptExecutor } from "../src/execution/attempt-executor.js";
import { WebhookHandler } from "../src/execution/webhook-handler.js";
import { RazorpayClient } from "../src/execution/razorpay-client.js";
import type { OutcomeResolver, OutcomeVerdict } from "../src/domain/ports.js";
import type { GatewayOrder, GatewayPayment, GatewayPaymentLink, PaymentGateway } from "../src/domain/gateway.js";
import { LoggingNotifier } from "../src/execution/notifier.js";
import type { CaseEnqueuer } from "../src/domain/ports.js";

const adminUrl = process.env.ADMIN_DATABASE_URL;
const SECRET = "whsec_test";
const noopQueue: CaseEnqueuer = { enqueue: async () => undefined };

class FakeGateway implements PaymentGateway {
  orderCreates = 0;
  async createOrder(i: { amountPaise: number }): Promise<GatewayOrder> {
    this.orderCreates++;
    return { id: `order_wh_${this.orderCreates}`, amountPaise: i.amountPaise };
  }
  async createPaymentLink(i: { amountPaise: number }): Promise<GatewayPaymentLink> {
    return { id: "plink_wh", url: "x", amountPaise: i.amountPaise };
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

// The webhook is what tells us the customer actually paid; the resolver reflects that.
class PaidOnceResolver implements OutcomeResolver {
  calls = 0;
  async resolve(): Promise<OutcomeVerdict> {
    this.calls++;
    return { kind: "recovered", capturedPaise: 149900, paymentId: "pay_wh_1" };
  }
}

function signed(body: object): { rawBody: string; signature: string; eventId: string } {
  const rawBody = JSON.stringify(body);
  return {
    rawBody,
    signature: createHmac("sha256", SECRET).update(rawBody).digest("hex"),
    eventId: `evt_${randomUUID()}`,
  };
}

describe.runIf(adminUrl)("WebhookHandler", () => {
  let db: Db;
  let caseId: string;
  let orderRef: string;

  const client = new RazorpayClient({ keyId: "k", keySecret: "s", webhookSecret: SECRET });

  const build = (resolver: OutcomeResolver) => {
    const attempts = new PostgresAttemptRepository(db);
    const cases = new PostgresCaseRepository(db);
    const events = new PostgresEventLog(db);
    const executor = new AttemptExecutor(attempts, events, new FakeGateway(), resolver, new LoggingNotifier(events));
    return {
      handler: new WebhookHandler({
        client,
        inbox: new PostgresWebhookInbox(db),
        attempts,
        cases,
        events,
        executor,
        enqueuer: noopQueue,
        merchantRef: "merch_1",
      }),
      attempts,
      cases,
    };
  };

  beforeAll(async () => {
    db = createPool(adminUrl!);
  });

  afterEach(async () => {
    await db.query("DELETE FROM razorpay_webhooks WHERE event LIKE 'payment%' OR event LIKE 'order%'");
    if (caseId) {
      await db.query("DELETE FROM recovery_events WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_attempts WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_cases WHERE id = $1", [caseId]);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  async function seedPendingAttempt(): Promise<void> {
    caseId = randomUUID();
    await new PostgresCaseRepository(db).create({
      id: caseId,
      runId: null,
      merchantRef: "m",
      customerRef: "c",
      originalPaymentId: null,
      amountPaise: 149900,
      currency: "INR",
      failureCode: "BAD_REQUEST_ERROR",
      failureReason: "card_declined",
      failedAt: new Date().toISOString(),
      customerHistory: [],
    });
    const attempts = new PostgresAttemptRepository(db);
    const { attempt } = await attempts.claim(
      {
        caseId,
        attemptNo: 1,
        rootCause: "soft_decline",
        action: { kind: "PAYMENT_LINK", rail: "card" },
        reasoning: "seed",
        amountPaise: 149900,
        currency: "INR",
        scheduledFor: null,
        clamp: null,
        createdAt: new Date().toISOString(),
      },
      `${caseId}:1`,
    );
    orderRef = "order_wh_seed";
    await attempts.recordRazorpayRef(attempt.id, orderRef);
  }

  const capturedEvent = () => ({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_wh_1", order_id: orderRef, amount: 149900, status: "captured" } } },
  });

  it("rejects a webhook with a bad signature and does nothing", async () => {
    await seedPendingAttempt();
    const { handler } = build(new PaidOnceResolver());
    const res = await handler.handle({ rawBody: JSON.stringify(capturedEvent()), signature: "deadbeef", eventId: "evt_x" });
    expect(res.status).toBe("invalid_signature");
  });

  it("processes payment.captured into a real ledger credit", async () => {
    await seedPendingAttempt();
    const { handler, cases } = build(new PaidOnceResolver());
    const res = await handler.handle(signed(capturedEvent()));
    expect(res).toEqual({ status: "processed", attemptStatus: "RECOVERED" });
    expect((await cases.byId(caseId))!.recoveredPaise).toBe(149900);
  });

  it("marks a real payment id's capture as not simulated", async () => {
    await seedPendingAttempt();
    const { handler } = build(new PaidOnceResolver());
    await handler.handle(signed(capturedEvent()));
    const tape = await new PostgresEventLog(db).forCase(caseId);
    const outcome = tape.find((e) => e.type === "ATTEMPT_OUTCOME" && e.payload.via === "webhook");
    expect(outcome?.payload.simulated).toBe(false);
  });

  it("marks a pay_sim_-prefixed capture (the demo's own button) as simulated", async () => {
    await seedPendingAttempt();
    const { handler } = build(new PaidOnceResolver());
    const simEvent = {
      event: "payment.captured",
      payload: {
        payment: { entity: { id: "pay_sim_abc123", order_id: orderRef, amount: 149900, status: "captured" } },
      },
    };
    await handler.handle(signed(simEvent));
    const tape = await new PostgresEventLog(db).forCase(caseId);
    const outcome = tape.find((e) => e.type === "ATTEMPT_OUTCOME" && e.payload.via === "webhook");
    expect(outcome?.payload.simulated).toBe(true);
    const resolved = tape.find((e) => e.type === "CASE_RESOLVED");
    expect(resolved?.payload.simulated).toBe(true);
  });

  it("ignores a duplicate delivery of the same event id — no second credit", async () => {
    await seedPendingAttempt();
    const resolver = new PaidOnceResolver();
    const { handler, cases } = build(resolver);

    const evt = signed(capturedEvent());
    const first = await handler.handle(evt);
    const second = await handler.handle(evt);

    expect(first.status).toBe("processed");
    expect(second.status).toBe("duplicate");
    expect((await cases.byId(caseId))!.recoveredPaise).toBe(149900);
  });

  it("settles a redelivered event whose first delivery never finished settling", async () => {
    await seedPendingAttempt();
    const { handler, cases } = build(new PaidOnceResolver());
    const evt = signed(capturedEvent());

    // Simulate a crash between recording the event id and settling the attempt: the inbox
    // already has this event id, but the attempt is still PENDING.
    await new PostgresWebhookInbox(db).recordIfNew(evt.eventId, "payment.captured", JSON.parse(evt.rawBody));

    const redelivery = await handler.handle(evt);
    expect(redelivery).toEqual({ status: "processed", attemptStatus: "RECOVERED" });
    expect((await cases.byId(caseId))!.recoveredPaise).toBe(149900);
  });

  it("moves the lane on a redelivery whose first delivery crashed between settle and lane move", async () => {
    await seedPendingAttempt();
    const { handler, attempts, cases } = build(new PaidOnceResolver());
    const evt = signed(capturedEvent());
    await new PostgresWebhookInbox(db).recordIfNew(evt.eventId, "payment.captured", JSON.parse(evt.rawBody));

    const attempt = (await attempts.listByCase(caseId))[0]!;
    await attempts.settleRecovered(attempt.id, 149900, "pay_wh_crash");

    const redelivery = await handler.handle(evt);
    expect(redelivery.status).toBe("duplicate");
    expect((await cases.byId(caseId))!.lane).toBe("RECOVERED");
  });

  it("does not credit a capture whose amount does not match the case", async () => {
    await seedPendingAttempt();
    const { handler, cases } = build(new PaidOnceResolver());
    const mismatched = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_wh_1", order_id: orderRef, amount: 999, status: "captured" } } },
    };

    const res = await handler.handle(signed(mismatched));

    expect(res).toEqual({ status: "processed", attemptStatus: "AWAITING_RECONCILIATION" });
    expect((await cases.byId(caseId))!.recoveredPaise).toBe(0);
  });

  it("ignores events it does not act on", async () => {
    await seedPendingAttempt();
    const { handler } = build(new PaidOnceResolver());
    const res = await handler.handle(signed({ event: "payment.authorized", payload: {} }));
    expect(res.status).toBe("ignored");
  });

  it("reports an unmatched ref rather than throwing", async () => {
    await seedPendingAttempt();
    const { handler } = build(new PaidOnceResolver());
    const res = await handler.handle(
      signed({
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_z", order_id: "order_unknown", amount: 1, status: "captured" } } },
      }),
    );
    expect(res.status).toBe("unmatched");
  });

  const failedEvent = (paymentId: string) => ({
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: 99900,
          status: "failed",
          method: "card",
          error_code: "BAD_REQUEST_ERROR",
          error_reason: "card_declined",
          email: "customer@example.com",
          card: { issuer: "HDFC" },
        },
      },
    },
  });

  it("ingests a payment.failed webhook into a new, queued case", async () => {
    const { handler, cases } = build(new PaidOnceResolver());
    const res = await handler.handle(signed(failedEvent("pay_fail_1")));
    expect(res.status).toBe("ingested");
    if (res.status !== "ingested") return;
    caseId = res.caseId;

    const kase = await cases.byId(res.caseId);
    expect(kase).toMatchObject({
      customerRef: "customer@example.com",
      originalPaymentId: "pay_fail_1",
      amountPaise: 99900,
      failureReason: "card_declined",
      method: "card",
      instrument: { issuer: "HDFC" },
      lane: "INCOMING",
    });
  });

  it("does not create a second case for the same payment id, even on a fresh event id", async () => {
    const { handler, cases } = build(new PaidOnceResolver());
    const first = await handler.handle(signed(failedEvent("pay_fail_2")));
    expect(first.status).toBe("ingested");
    if (first.status !== "ingested") return;
    caseId = first.caseId;

    const second = await handler.handle(signed(failedEvent("pay_fail_2")));
    expect(second).toEqual({ status: "ingested", caseId: first.caseId });

    const all = await cases.listLive();
    expect(all.filter((c) => c.originalPaymentId === "pay_fail_2")).toHaveLength(1);
  });

  it("ignores a redelivered payment.failed event id", async () => {
    const { handler, cases } = build(new PaidOnceResolver());
    const evt = signed(failedEvent("pay_fail_3"));
    const first = await handler.handle(evt);
    expect(first.status).toBe("ingested");
    if (first.status !== "ingested") return;
    caseId = first.caseId;

    const redelivery = await handler.handle(evt);
    expect(redelivery.status).toBe("duplicate");
    expect((await cases.listLive()).filter((c) => c.originalPaymentId === "pay_fail_3")).toHaveLength(1);
  });
});
