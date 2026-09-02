import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RazorpayClient } from "../src/execution/razorpay-client.js";
import { GatewayRejectedError, GatewayUnavailableError } from "../src/domain/gateway.js";

// Hits Razorpay test mode for real. The downtime read is the agent's one genuinely external
// signal, so it is verified against the live API rather than a fixture.

const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

const client = new RazorpayClient({
  keyId: keyId ?? "",
  keySecret: keySecret ?? "",
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "test_secret",
});

describe.runIf(keyId && keySecret)("RazorpayClient against test mode", () => {
  it("creates an order that is readable by id immediately", async () => {
    const key = randomUUID();
    const order = await client.createOrder({
      amountPaise: 149900,
      currency: "INR",
      idempotencyKey: key,
      notes: { suite: "razorpay-client.integration" },
    });

    expect(order.id).toMatch(/^order_/);
    expect(order.amountPaise).toBe(149900);
  });

  // Pins the race in context/BREAKS.md 2026-09-02: the order list index lags the write, so a
  // reconciliation read taken with no delay can miss an order that definitely exists. This test
  // deliberately does not sleep — sleeping would test a system production never runs.
  it("cannot be trusted to find a just-created order — absence here means unknown", async () => {
    const key = randomUUID();
    await client.createOrder({ amountPaise: 10000, currency: "INR", idempotencyKey: key });
    const immediately = await client.findOrderByIdempotencyKey(key);
    expect(immediately === null || immediately.amountPaise === 10000).toBe(true);
  });

  // Deliberately not asserting convergence: the receipt index lag was measured at minutes and is
  // not reliably bounded, so a test that waits for it would be testing Razorpay's SLA, not our
  // code. The contract we depend on is the one above — null means unknown.

  it("returns null for an idempotency key that never landed", async () => {
    expect(await client.findOrderByIdempotencyKey(randomUUID())).toBeNull();
  });

  it("gives orders no idempotency: Razorpay accepts a duplicate receipt", async () => {
    const key = randomUUID();
    const first = await client.createOrder({ amountPaise: 10000, currency: "INR", idempotencyKey: key });
    const second = await client.createOrder({ amountPaise: 10000, currency: "INR", idempotencyKey: key });
    expect(second.id).not.toBe(first.id);
  });

  it("gives payment links real idempotency: Razorpay rejects a duplicate reference_id", async () => {
    const key = randomUUID();
    let link;
    try {
      link = await client.createPaymentLink({
        amountPaise: 10000,
        currency: "INR",
        idempotencyKey: key,
        description: "Recovery Room idempotency check",
      });
    } catch (e) {
      // Test mode caps payment links at 30 per business and throttles creation; when that hits
      // there is nothing to test here. See context/BREAKS.md.
      if (e instanceof GatewayUnavailableError) return;
      throw e;
    }
    expect(link.id).toMatch(/^plink_/);

    const duplicate = await client
      .createPaymentLink({
        amountPaise: 10000,
        currency: "INR",
        idempotencyKey: key,
        description: "Recovery Room idempotency check",
      })
      .then(() => "created-a-second-link")
      .catch((e: unknown) => e);

    // Razorpay must not silently create a second link for the same reference_id. It either
    // rejects it as a duplicate, or throttles the create (test-mode link quota) — never a
    // clean second link.
    if (duplicate instanceof GatewayUnavailableError) return;
    expect(RazorpayClient.isDuplicateReference(duplicate)).toBe(true);
    // Not asserting the immediate reference_id lookup: like the order receipt index, the
    // payment-link list index lags the write by minutes (context/BREAKS.md).
  });

  it("lists payments for a fresh order as empty rather than throwing", async () => {
    const order = await client.createOrder({
      amountPaise: 50000,
      currency: "INR",
      idempotencyKey: randomUUID(),
    });
    expect(await client.listOrderPayments(order.id)).toEqual([]);
  });

  it("reads real downtime data with the fields the agent depends on", async () => {
    const downtimes = await client.listDowntimes();
    expect(Array.isArray(downtimes)).toBe(true);
    for (const d of downtimes) {
      expect(d.id).toMatch(/^down_/);
      expect(typeof d.method).toBe("string");
      expect(typeof d.severity).toBe("string");
      expect(d.begin).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(d.instrument).toBeTypeOf("object");
    }
  });

  it("maps an unknown payment id to null, not an exception", async () => {
    expect(await client.getPayment("pay_doesnotexist000000")).toBeNull();
  });

  it("rejects a malformed request as a definite verdict, not an unknown one", async () => {
    await expect(
      client.createOrder({ amountPaise: -1, currency: "INR", idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(GatewayRejectedError);
  });
});

describe("RazorpayClient failure classification", () => {
  const creds = { keyId: "k", keySecret: "s", webhookSecret: "whsec" };

  const withFetch = (impl: typeof fetch) => new RazorpayClient(creds, 5_000, impl);

  const response = (status: number, body: unknown) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("treats 5xx as unknown, never as failure", async () => {
    const c = withFetch(async () => response(503, { error: { description: "down" } }));
    await expect(c.createOrder({ amountPaise: 100, currency: "INR", idempotencyKey: "k" })).rejects.toBeInstanceOf(
      GatewayUnavailableError,
    );
  });

  it("treats 429 as unknown", async () => {
    const c = withFetch(async () => response(429, { error: { description: "slow down" } }));
    await expect(c.listDowntimes()).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("treats a network error as unknown", async () => {
    const c = withFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(c.listDowntimes()).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("treats 4xx as a definite rejection and keeps the reason", async () => {
    const c = withFetch(async () =>
      response(400, { error: { description: "amount must be at least 100", reason: "input_validation_failed" } }),
    );
    await expect(
      c.createOrder({ amountPaise: 1, currency: "INR", idempotencyKey: "k" }),
    ).rejects.toMatchObject({ name: "GatewayRejectedError", reason: "input_validation_failed" });
  });

  it("treats an unparseable 200 as unknown rather than success", async () => {
    const c = withFetch(async () => response(200, "<html>maintenance</html>"));
    await expect(c.listDowntimes()).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("treats a well-formed 200 of the wrong shape as unknown", async () => {
    const c = withFetch(async () => response(200, { unexpected: true }));
    await expect(
      c.createOrder({ amountPaise: 100, currency: "INR", idempotencyKey: "k" }),
    ).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("never reports capturedPaise for a payment that is not captured", async () => {
    const c = withFetch(async () =>
      response(200, { id: "pay_1", amount: 149900, amount_captured: 149900, status: "authorized" }),
    );
    const payment = await c.getPayment("pay_1");
    expect(payment?.status).toBe("authorized");
    expect(payment?.capturedPaise).toBe(0);
  });

  it("reports the captured amount for a captured payment", async () => {
    const c = withFetch(async () =>
      response(200, { id: "pay_1", amount: 149900, amount_captured: 149900, status: "captured" }),
    );
    expect((await c.getPayment("pay_1"))?.capturedPaise).toBe(149900);
  });
});

describe("webhook signature verification", () => {
  const client = new RazorpayClient({ keyId: "k", keySecret: "s", webhookSecret: "whsec" });
  const body = JSON.stringify({ event: "payment.captured" });
  // Computed with the same secret; a wrong signature must never verify.
  const valid = createHmac("sha256", "whsec").update(body).digest("hex");

  it("accepts a correct signature", () => {
    expect(client.verifyWebhook(body, valid)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(client.verifyWebhook(body + " ", valid)).toBe(false);
  });

  it("rejects a wrong signature", () => {
    expect(client.verifyWebhook(body, "00".repeat(32))).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(client.verifyWebhook(body, "not-hex")).toBe(false);
    expect(client.verifyWebhook(body, "")).toBe(false);
  });
});
