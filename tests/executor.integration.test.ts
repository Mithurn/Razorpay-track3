import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createHmac, randomUUID } from "node:crypto";
import { Executor } from "../src/executor/executor.js";
import { ExecutionStore } from "../src/executor/store.js";
import { PostgresGateClearanceRepository } from "../src/investigation/gate-clearance.js";
import { RazorpayServerError, type RazorpayClient, type WebhookEnvelope } from "../src/executor/razorpay.js";
import { createWebhookHandler, type WebhookResult } from "../src/executor/webhooks.js";
import { generateKeyPair, createMandate, signProposal } from "../src/mandates/signer.js";

const d = process.env.DATABASE_URL ? describe : describe.skip;

if (!process.env.DATABASE_URL) {
  console.log("Skipping executor integration tests: DATABASE_URL not set.");
}

class StubRazorpay implements RazorpayClient {
  orderCreateCount = 0;
  captureCount = 0;
  orderPayments: Record<string, Array<{ id: string; order_id: string | null; status: string; amount: number }>> = {};
  captureBehavior: "success" | "server_error" | "timeout" = "success";
  paymentTruth: Record<string, string> = {};
  seededPayments: Record<string, string> = {};

  async createOrder(input: { amountPaise: number; receipt: string }) {
    this.orderCreateCount += 1;
    return { id: `order_${input.receipt.slice(0, 8)}`, status: "created", receipt: input.receipt, amount: input.amountPaise };
  }

  async getPaymentsForOrder(orderId: string) {
    return this.orderPayments[orderId] ?? [];
  }

  async getPayment(paymentId: string) {
    const status = this.paymentTruth[paymentId] ?? this.seededPayments[paymentId];
    if (!status) return null;
    return { id: paymentId, order_id: null, status, amount: 4500000 };
  }

  async capture(paymentId: string, _input: { amountPaise: number }) {
    this.captureCount += 1;
    if (this.captureBehavior === "server_error") {
      throw new RazorpayServerError(500, "internal error");
    }
    if (this.captureBehavior === "timeout") {
      throw new Error("network timeout");
    }
    this.paymentTruth[paymentId] = "captured";
    return { id: paymentId, order_id: null, status: "captured", amount: 4500000 };
  }

  verifyWebhookSignature(rawBody: string, signature: string) {
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return expected === signature;
  }

  parseWebhook(rawBody: string): WebhookEnvelope | null {
    const parsed = JSON.parse(rawBody) as {
      event: string;
      payload?: { payment?: NonNullable<WebhookEnvelope["payment"]> };
    };
    const payment = parsed.payload?.payment ?? null;
    return {
      event: parsed.event,
      eventId: parsed.event ? `${parsed.event}:${payment?.id ?? "none"}` : null,
      payment: payment ? { ...payment, orderId: payment.order_id } : null,
    };
  }

  seedAuthorizedPayment(orderId: string, paymentId: string, status = "authorized") {
    this.orderPayments[orderId] = [{ id: paymentId, order_id: orderId, status, amount: 4500000 }];
    this.seededPayments[paymentId] = status;
  }
}

const secret = "test-webhook-secret";
function signedWebhook(body: Record<string, unknown>, useSecret = secret) {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", useSecret).update(raw).digest("hex");
  return { raw, signature };
}

d("executor", () => {
  let pool: Pool;
  let adminPool: Pool;
  let store: ExecutionStore;
  let stub: StubRazorpay;
  let executor: Executor;
  let handleWebhook: (raw: string, sig?: string) => Promise<WebhookResult>;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: process.env.ADMIN_DATABASE_URL ?? "postgres://aegis:aegis_dev@localhost:5433/aegis",
    });
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    store = new ExecutionStore(pool);
    stub = new StubRazorpay();
    executor = new Executor({ pool, razorpay: stub, store, gate: new PostgresGateClearanceRepository(pool) });
    handleWebhook = createWebhookHandler({ pool, razorpay: stub, store, executor });
  });

  afterAll(async () => {
    await Promise.all([pool.end(), adminPool.end()]);
  });

  beforeEach(async () => {
    await reset();
    stub = new StubRazorpay();
    executor = new Executor({ pool, razorpay: stub, store, gate: new PostgresGateClearanceRepository(pool) });
    handleWebhook = createWebhookHandler({ pool, razorpay: stub, store, executor });
  });

  async function reset() {
    await adminPool.query("TRUNCATE mandate_decisions, consumed_nonces, mandates, executor_jobs, execution_events, webhook_events, investigation_events");
  }

  async function seedAllow(overrides: Record<string, unknown> = {}): Promise<string> {
    const correlationId = randomUUID();
    const keyPair = generateKeyPair();
    const mandate = createMandate(
      {
        intent: "Buy one Apple Watch under Rs 50,000",
        amountCapPaise: 5_000_000,
        merchantAllowlist: ["apple.com"],
        ...overrides,
      },
      keyPair,
    );
    await pool.query(
      `INSERT INTO mandates (id, payload, signature, public_key) VALUES ($1, $2, $3, $4)`,
      [mandate.id, mandate.payload, mandate.signature, mandate.publicKeyPem],
    );
    const agentKeyPair = generateKeyPair();
    const agentId = `agent-${correlationId}`;
    const unsignedProposal = {
      item: "Apple Watch",
      amountPaise: 4_500_000,
      merchant: "apple.com",
      nonce: `nonce-${correlationId}`,
      agentId,
    };
    await pool.query(
      `INSERT INTO mandate_decisions (correlation_id, mandate_id, agent_id, proposal, decision, reason, checks)
       VALUES ($1, $2, $3, $4, 'ALLOW', 'all_checks_passed', '[]')`,
      [
        correlationId,
        mandate.id,
        agentId,
        JSON.stringify({
          ...unsignedProposal,
          agentSignature: signProposal(unsignedProposal, agentKeyPair.privateKeyPem),
        }),
      ],
    );
    return correlationId;
  }

  async function seedAuthorizedPayment(correlationId: string, status = "authorized") {
    const job = await store.getJob(correlationId);
    stub.seedAuthorizedPayment(`order_${correlationId.slice(0, 8)}`, `pay_${correlationId.slice(0, 8)}`, status);
    return { job, orderId: `order_${correlationId.slice(0, 8)}`, paymentId: `pay_${correlationId.slice(0, 8)}` };
  }

  it("runs the happy path: ALLOW → order → authorized → captured, exactly one order and one capture", async () => {
    const correlationId = await seedAllow();
    const first = await executor.execute(correlationId);
    expect(first.state).toBe("AWAITING_PAYMENT");
    const { job, paymentId } = await seedAuthorizedPayment(correlationId);
    const outcome = await executor.advance(job as NonNullable<typeof job>, 4_500_000);
    expect(outcome.state).toBe("CAPTURED");
    expect(stub.orderCreateCount).toBe(1);
    expect(stub.captureCount).toBe(1);
    expect(stub.paymentTruth[paymentId]).toBe("captured");
  });

  it("two concurrent executors race the same ALLOW: one order, one capture, no double-capture", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    const { job, paymentId } = await seedAuthorizedPayment(correlationId);
    const theJob = job as NonNullable<typeof job>;

    const results = await Promise.all([
      executor.advance(theJob, 4_500_000),
      executor.advance(theJob, 4_500_000),
    ]);
    // both callers may observe the final CAPTURED state, but the capture effect happened once
    expect(results.every((r) => r.state === "CAPTURED")).toBe(true);
    expect(stub.captureCount).toBe(1);

    // the loser re-runs (BullMQ retry or operator action): sees the winner's outcome, no re-capture
    const rerun = await executor.advance((await store.getJob(correlationId)) as NonNullable<typeof job>, 4_500_000);
    expect(rerun.state).toBe("CAPTURED");
    expect(stub.captureCount).toBe(1);
    expect(stub.paymentTruth[paymentId]).toBe("captured");

    const events = await pool.query(
      `SELECT event FROM execution_events WHERE correlation_id = $1 AND event = 'CAPTURED'`,
      [correlationId],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("capture 5xx: no success assumed, reconciliation polls the API and finds captured", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    const { job, paymentId } = await seedAuthorizedPayment(correlationId);

    stub.captureBehavior = "server_error";
    const afterFailure = await executor.advance(job as NonNullable<typeof job>, 4_500_000);
    expect(afterFailure.state).toBe("AWAITING_PAYMENT");
    expect(stub.paymentTruth[paymentId]).toBeUndefined();

    stub.paymentTruth[paymentId] = "captured";
    const reconciled = await executor.advance(
      (await store.getJob(correlationId)) as NonNullable<typeof job>,
      4_500_000,
    );
    expect(reconciled.state).toBe("CAPTURED");
    const finalJob = await store.getJob(correlationId);
    expect(finalJob?.state).toBe("CAPTURED");
  });

  it("capture timeout: unknown outcome → reconciliation finds still-authorized → retry capture succeeds", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    const { job, paymentId } = await seedAuthorizedPayment(correlationId);

    stub.captureBehavior = "timeout";
    const outcome = await executor.advance(job as NonNullable<typeof job>, 4_500_000);
    expect(outcome.state).toBe("AWAITING_PAYMENT");

    stub.captureBehavior = "success";
    const retried = await executor.advance((await store.getJob(correlationId)) as NonNullable<typeof job>, 4_500_000);
    expect(retried.state).toBe("CAPTURED");
    expect(stub.paymentTruth[paymentId]).toBe("captured");
    const capturedEvents = await pool.query(
      `SELECT event FROM execution_events WHERE correlation_id = $1 AND event = 'CAPTURED'`,
      [correlationId],
    );
    expect(capturedEvents.rows).toHaveLength(1);
  });

  it("worker crash during capture: state CAPTURING is resumed by reconciliation, no double capture", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    const { job, paymentId } = await seedAuthorizedPayment(correlationId);

    await store.transition((job as NonNullable<typeof job>).correlationId, "CAPTURING", { paymentId });

    stub.paymentTruth[paymentId] = "captured";
    const resumed = await executor.execute(correlationId);
    expect(resumed.state).toBe("CAPTURED");
    expect(stub.captureCount).toBe(0);
  });

  it("duplicate webhooks collapse to no-ops", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    const { paymentId } = await seedAuthorizedPayment(correlationId, "captured");
    stub.paymentTruth[paymentId] = "captured";
    const preJob = await store.getJob(correlationId);
    await executor.advance(preJob as NonNullable<typeof preJob>, 4_500_000);
    expect((await store.getJob(correlationId))?.state).toBe("CAPTURED");

    const { raw, signature } = signedWebhook({
      event: "payment.captured",
      payload: { payment: { id: paymentId, order_id: `order_${correlationId.slice(0, 8)}`, status: "captured", amount: 4500000 } },
    });
    const first = await handleWebhook(raw, signature);
    expect(first.handled).toBe("accepted");
    const second = await handleWebhook(raw, signature);
    expect(second.handled).toBe("duplicate");

    const delivered = await pool.query(
      `SELECT event FROM webhook_events`,
    );
    expect(delivered.rows).toHaveLength(1);
  });

  it("out-of-order webhook: late payment.captured after FAILED is recorded as evidence but cannot resurrect or double-capture", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    const { job, paymentId } = await seedAuthorizedPayment(correlationId);

    stub.captureBehavior = "server_error";
    await executor.advance(job as NonNullable<typeof job>, 4_500_000);
    stub.paymentTruth[paymentId] = "failed";
    const failed = await executor.advance((await store.getJob(correlationId)) as NonNullable<typeof job>, 4_500_000);
    expect(failed.state).toBe("FAILED");

    stub.paymentTruth[paymentId] = "captured";
    const { raw, signature } = signedWebhook({
      event: "payment.captured",
      payload: { payment: { id: paymentId, order_id: `order_${correlationId.slice(0, 8)}`, status: "captured", amount: 4500000 } },
    });
    const result = await handleWebhook(raw, signature);
    expect(result.handled).toBe("accepted");

    // evidence recorded, but a FAILED job is terminal: no resurrection, no second capture
    expect((await store.getJob(correlationId))?.state).toBe("FAILED");
    expect(stub.captureCount).toBe(2);
    const events = await pool.query(
      `SELECT event FROM execution_events WHERE correlation_id = $1 ORDER BY id`,
      [correlationId],
    );
    expect(events.rows.some((r) => r.event === "WEBHOOK_RECEIVED")).toBe(true);
    expect(events.rows.filter((r) => r.event === "CAPTURED")).toHaveLength(0);
  });

  it("bad webhook signature is rejected without state change", async () => {
    const { raw, signature } = signedWebhook({ event: "payment.captured", payload: {} }, "wrong-secret");
    const result = await handleWebhook(raw, signature);
    expect(result.handled).toBe("bad_signature");
  });

  it("execution is refused when the mandate expired after the ALLOW", async () => {
    const correlationId = await seedAllow({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const outcome = await executor.execute(correlationId);
    expect(outcome.state).toBe("FAILED");
    expect(stub.orderCreateCount).toBe(0);
    const events = await pool.query(
      `SELECT payload FROM execution_events WHERE correlation_id = $1 AND event = 'FAILED'`,
      [correlationId],
    );
    expect(events.rows[0]?.payload).toMatchObject({ reason: "mandate_expired_at_execution_time" });
  });

  it("execute on a correlation id with no ALLOW fails closed", async () => {
    const outcome = await executor.execute(randomUUID());
    expect(outcome.state).toBe("FAILED");
  });

  it("refuses to start execution while an investigation is open and un-released", async () => {
    const correlationId = await seedAllow();
    await pool.query(
      `INSERT INTO investigation_events (investigation_id, correlation_id, agent_id, event, payload)
       VALUES ($1, $2, $3, 'INVESTIGATION_STARTED', '{}')`,
      [randomUUID(), correlationId, `agent-${correlationId}`],
    );

    const outcome = await executor.execute(correlationId);
    expect(outcome.state).toBe("FAILED");
    expect(stub.orderCreateCount).toBe(0);
    const events = await pool.query(
      `SELECT payload FROM execution_events WHERE correlation_id = $1 AND event = 'FAILED'`,
      [correlationId],
    );
    expect(events.rows[0]?.payload).toMatchObject({ reason: "investigation_not_cleared" });
  });

  it("proceeds once the investigation is released by a human", async () => {
    const correlationId = await seedAllow();
    const investigationId = randomUUID();
    await pool.query(
      `INSERT INTO investigation_events (investigation_id, correlation_id, agent_id, event, payload)
       VALUES ($1, $2, $3, 'INVESTIGATION_STARTED', '{}'),
              ($1, $2, $3, 'RELEASED', '{}')`,
      [investigationId, correlationId, `agent-${correlationId}`],
    );

    const outcome = await executor.execute(correlationId);
    expect(outcome.state).toBe("AWAITING_PAYMENT");
    expect(stub.orderCreateCount).toBe(1);
  });

  it("sweep advances a stuck AWAITING_PAYMENT job to CAPTURED once the payment is authorized", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    const { paymentId } = await seedAuthorizedPayment(correlationId);

    const outcomes = await executor.sweepStuckJobs(0);
    expect(outcomes.map((o) => o.state)).toEqual(["CAPTURED"]);
    expect(stub.captureCount).toBe(1);
    expect(stub.paymentTruth[paymentId]).toBe("captured");
    expect((await store.getJob(correlationId))?.state).toBe("CAPTURED");
  });

  it("sweep resolves an AWAITING_RECONCILIATION job from API truth", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    const { job, paymentId } = await seedAuthorizedPayment(correlationId);
    stub.captureBehavior = "server_error";
    await executor.advance(job as NonNullable<typeof job>, 4_500_000);
    stub.paymentTruth[paymentId] = "captured";

    const outcomes = await executor.sweepStuckJobs(0);
    expect(outcomes.map((o) => o.state)).toEqual(["CAPTURED"]);
  });

  it("concurrent sweeps are safe: exactly one capture", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    await seedAuthorizedPayment(correlationId);

    const results = await Promise.all([executor.sweepStuckJobs(0), executor.sweepStuckJobs(0)]);
    expect(stub.captureCount).toBe(1);
    expect((await store.getJob(correlationId))?.state).toBe("CAPTURED");
    // A losing sweep may report the in-flight CAPTURING state; the invariant is one capture effect.
    const flat = results.flat();
    expect(flat.every((o) => ["CAPTURED", "CAPTURING"].includes(o.state))).toBe(true);
  });

  it("sweep refuses to capture after mandate expiry", async () => {
    const correlationId = await seedAllow();
    await executor.execute(correlationId);
    seedAuthorizedPayment(correlationId);

    await adminPool.query(
      `UPDATE mandates SET payload = jsonb_set(payload, '{expiresAt}', to_jsonb(to_char(now() - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`,
    );

    const outcomes = await executor.sweepStuckJobs(0);
    expect(outcomes.map((o) => o.state)).toEqual(["FAILED"]);
    expect(stub.captureCount).toBe(0);
    const events = await pool.query(
      `SELECT payload FROM execution_events WHERE correlation_id = $1 AND event = 'FAILED'`,
      [correlationId],
    );
    expect(events.rows[0]?.payload).toMatchObject({ reason: "mandate_expired_at_execution_time" });
  });

  it("sweep fails a job whose ALLOW record is unparseable", async () => {
    const correlationId = randomUUID();
    await pool.query(
      `INSERT INTO mandate_decisions (correlation_id, decision, reason, checks, proposal)
       VALUES ($1, 'ALLOW', 'all_checks_passed', '[]', '{"broken": true}')`,
      [correlationId],
    );
    await store.createJobIfAllowed(correlationId);

    const outcomes = await executor.sweepStuckJobs(0);
    expect(outcomes.map((o) => o.state)).toEqual(["FAILED"]);
    expect(stub.orderCreateCount).toBe(0);
  });
});
