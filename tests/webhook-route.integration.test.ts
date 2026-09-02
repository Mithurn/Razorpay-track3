import { createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { PostgresWebhookInbox } from "../src/persistence/webhook-inbox.js";
import { RunRepository } from "../src/persistence/run-repository.js";
import { AttemptExecutor } from "../src/execution/attempt-executor.js";
import { WebhookHandler } from "../src/execution/webhook-handler.js";
import { RazorpayClient } from "../src/execution/razorpay-client.js";
import { CaseEventBus } from "../src/api/event-bus.js";
import { registerRoutes } from "../src/api/routes.js";
import type { OutcomeResolver } from "../src/domain/ports.js";
import type { GatewayOrder, GatewayPayment, GatewayPaymentLink, PaymentGateway } from "../src/domain/gateway.js";

const adminUrl = process.env.ADMIN_DATABASE_URL;
const SECRET = "whsec_route_test";

class FakeGateway implements PaymentGateway {
  async createOrder(i: { amountPaise: number }): Promise<GatewayOrder> {
    return { id: "order_route", amountPaise: i.amountPaise };
  }
  async createPaymentLink(i: { amountPaise: number }): Promise<GatewayPaymentLink> {
    return { id: "plink_route", url: "x", amountPaise: i.amountPaise };
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

describe.runIf(adminUrl)("POST /webhooks/razorpay", () => {
  let db: Db;
  let app: FastifyInstance;
  let caseId: string;
  let orderRef: string;

  beforeAll(async () => {
    db = createPool(adminUrl!);
  });

  afterEach(async () => {
    await app?.close();
    await db.query("DELETE FROM razorpay_webhooks WHERE event LIKE 'payment%'");
    if (caseId) {
      await db.query("DELETE FROM recovery_events WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_attempts WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_cases WHERE id = $1", [caseId]);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  async function buildApp(): Promise<void> {
    caseId = randomUUID();
    orderRef = "order_route_seed";
    const cases = new PostgresCaseRepository(db);
    const attempts = new PostgresAttemptRepository(db);
    const events = new PostgresEventLog(db);

    await cases.create({
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
      method: "card",
      instrument: null,
      customerHistory: [],
    });
    const { attempt } = await attempts.claim(
      {
        caseId,
        attemptNo: 1,
        rootCause: "soft_decline",
        action: { kind: "RETRY_NOW" },
        reasoning: "seed",
        amountPaise: 149900,
        currency: "INR",
        scheduledFor: null,
        clamp: null,
        createdAt: new Date().toISOString(),
      },
      `${caseId}:1`,
    );
    await attempts.recordRazorpayRef(attempt.id, orderRef);

    const client = new RazorpayClient({ keyId: "k", keySecret: "s", webhookSecret: SECRET });
    const resolver: OutcomeResolver = {
      resolve: async () => ({ kind: "recovered", capturedPaise: 149900, paymentId: "pay_route_1" }),
    };
    const executor = new AttemptExecutor(attempts, events, new FakeGateway(), resolver);
    const handler = new WebhookHandler(client, new PostgresWebhookInbox(db), attempts, cases, events, executor);

    app = Fastify();
    app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, body === "" ? undefined : JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    });
    await registerRoutes(app, {
      cases,
      attempts,
      events,
      runs: new RunRepository(db),
      queue: { add: async () => undefined } as never,
      webhookHandler: handler,
      bus: new CaseEventBus(),
      modelHealth: async () => ({ model: "test", reachable: true }),
      verifyAppendOnly: async () => ({ enforced: true, role: "recovery_app" }),
      runtimeInfo: {
        model: "test",
        deadlineMs: 90_000,
        stepBudget: 6,
        limits: { maxAttempts: 4, maxExposurePaise: 500000, cooldownHours: 6, minConfidence: 0.6 },
      },
      razorpayWebhookSecret: SECRET,
    });
  }

  function body(): string {
    return JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_route_1", order_id: orderRef, amount: 149900, status: "captured" } } },
    });
  }

  function sign(raw: string): string {
    return createHmac("sha256", SECRET).update(raw).digest("hex");
  }

  it("verifies the signature against the exact raw bytes and settles the case", async () => {
    await buildApp();
    const raw = body();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/razorpay",
      headers: { "content-type": "application/json", "x-razorpay-signature": sign(raw), "x-razorpay-event-id": "evt_r1" },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "processed", attemptStatus: "RECOVERED" });
    expect((await new PostgresCaseRepository(db).byId(caseId))!.recoveredPaise).toBe(149900);
  });

  it("rejects a bad signature with 401", async () => {
    await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/razorpay",
      headers: { "content-type": "application/json", "x-razorpay-signature": "bad", "x-razorpay-event-id": "evt_r2" },
      payload: body(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("drops a replayed event id", async () => {
    await buildApp();
    const raw = body();
    const headers = {
      "content-type": "application/json",
      "x-razorpay-signature": sign(raw),
      "x-razorpay-event-id": "evt_r3",
    };
    await app.inject({ method: "POST", url: "/webhooks/razorpay", headers, payload: raw });
    const second = await app.inject({ method: "POST", url: "/webhooks/razorpay", headers, payload: raw });
    expect(second.json()).toMatchObject({ status: "duplicate" });
    expect((await new PostgresCaseRepository(db).byId(caseId))!.recoveredPaise).toBe(149900);
  });
});
