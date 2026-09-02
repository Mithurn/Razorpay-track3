import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { RazorpayClient } from "../src/execution/razorpay-client.js";
import type { CustomerPayment } from "../src/domain/case.js";
import type { NewCase } from "../src/domain/ports.js";

// Seeds the live queue for the demo. The hero and its matched control share a customer profile;
// only the issuer differs, and the hero's issuer is pulled from Razorpay's real downtime feed
// so the agent's downtime tool genuinely matches it.

const cleanHistory = (base: number): CustomerPayment[] =>
  ["2026-05-01", "2026-06-02", "2026-07-01", "2026-08-03"].map((d) => ({
    paidAt: `${d}T10:00:00.000Z`,
    amountPaise: base,
    method: "card",
    status: "captured" as const,
  }));

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const cases = new PostgresCaseRepository(pool);

  const razorpay = new RazorpayClient({
    keyId: config.RAZORPAY_KEY_ID,
    keySecret: config.RAZORPAY_KEY_SECRET,
    webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
  });
  const downtimes = await razorpay.listDowntimes();
  const cardDown = downtimes.find((d) => d.method === "card" && d.status === "started" && d.instrument.issuer);
  if (!cardDown) throw new Error("no live card downtime to build the hero case around");
  const downIssuer = cardDown.instrument.issuer!;
  const upIssuer = ["HDFC", "ICIC", "AXIS"].find((i) => i !== downIssuer) ?? "HDFC";
  console.error(`hero issuer ${downIssuer} (live ${cardDown.severity} downtime); control issuer ${upIssuer}`);

  const base = 149900;
  const seeds: NewCase[] = [
    {
      id: randomUUID(),
      runId: null,
      merchantRef: "acme_subscriptions",
      customerRef: "cust_hero",
      originalPaymentId: null,
      amountPaise: base,
      currency: "INR",
      failureCode: "BAD_REQUEST_ERROR",
      failureReason: "card_declined",
      failedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
      method: "card",
      instrument: { issuer: downIssuer },
      customerHistory: cleanHistory(base),
    },
    {
      id: randomUUID(),
      runId: null,
      merchantRef: "acme_subscriptions",
      customerRef: "cust_control",
      originalPaymentId: null,
      amountPaise: base,
      currency: "INR",
      failureCode: "BAD_REQUEST_ERROR",
      failureReason: "card_declined",
      failedAt: new Date(Date.now() - 38 * 60_000).toISOString(),
      method: "card",
      instrument: { issuer: upIssuer },
      customerHistory: cleanHistory(base),
    },
    {
      id: randomUUID(),
      runId: null,
      merchantRef: "acme_subscriptions",
      customerRef: "cust_expired",
      originalPaymentId: null,
      amountPaise: 99900,
      currency: "INR",
      failureCode: "BAD_REQUEST_ERROR",
      failureReason: "card_expired",
      failedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      method: "card",
      instrument: { issuer: upIssuer },
      customerHistory: cleanHistory(99900),
    },
    {
      id: randomUUID(),
      runId: null,
      merchantRef: "acme_subscriptions",
      customerRef: "cust_riskhold",
      originalPaymentId: null,
      amountPaise: 449900,
      currency: "INR",
      failureCode: "BAD_REQUEST_ERROR",
      failureReason: "payment_risk_check_failed",
      failedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      method: "card",
      instrument: { issuer: upIssuer },
      customerHistory: cleanHistory(449900).slice(0, 1),
    },
  ];

  for (const c of seeds) {
    await cases.create(c);
    console.log(`${c.customerRef.padEnd(14)} ${c.id}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
