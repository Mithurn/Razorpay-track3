import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { RazorpayClient } from "../src/execution/razorpay-client.js";
import type { Pool } from "pg";
import type { CustomerPayment } from "../src/domain/case.js";

// Clean seed for the GIF demo: 5 historical recovered cases showing ₹10,000 baseline,
// plus 1 fresh INCOMING case (₹1,499) that will increase the total to ₹11,499 after completion.

const cleanHistory = (base: number): CustomerPayment[] =>
  ["2026-05-01", "2026-06-02", "2026-07-01", "2026-08-03"].map((d) => ({
    paidAt: `${d}T10:00:00.000Z`,
    amountPaise: base,
    method: "card",
    status: "captured" as const,
  }));

async function seedHistoricalRecovered(pool: Pool, issuer: string): Promise<void> {
  const now = Date.now();
  const day = 24 * 60 * 60_000;

  // 5 historical RECOVERED cases totaling ₹10,000
  const cases = [
    { daysAgo: 14, cust: "cust_2001", amount: 199900, issuer },
    { daysAgo: 12, cust: "cust_2002", amount: 199900, issuer },
    { daysAgo: 10, cust: "cust_2003", amount: 199900, issuer: "HDFC" },
    { daysAgo: 7, cust: "cust_2004", amount: 199900, issuer },
    { daysAgo: 5, cust: "cust_2005", amount: 200400, issuer: "ICIC" },
  ];

  for (const c of cases) {
    const caseId = randomUUID();
    const attemptId = randomUUID();
    const failedAt = new Date(now - c.daysAgo * day);
    const resolvedAt = new Date(failedAt.getTime() + 2 * 60 * 60_000); // 2h later

    await pool.query(
      `INSERT INTO recovery_cases
         (id, run_id, merchant_ref, customer_ref, original_payment_id,
          amount_paise, currency, failure_code, failure_reason, failed_at,
          method, instrument, customer_history, lane, recovered_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        caseId,
        null,
        "acme_subscriptions",
        c.cust,
        null,
        c.amount,
        "INR",
        "BAD_REQUEST_ERROR",
        "card_declined",
        failedAt.toISOString(),
        "card",
        JSON.stringify({ issuer: c.issuer }),
        JSON.stringify([]),
        "RECOVERED",
        c.amount,
      ],
    );

    await pool.query(
      `INSERT INTO recovery_attempts
         (id, case_id, attempt_no, root_cause, action, idempotency_key,
          outcome, recovered_paise, created_at, resolved_at)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
      [
        attemptId,
        caseId,
        "bank_downtime",
        "PAYMENT_LINK",
        `hist-${caseId}`,
        "RECOVERED",
        c.amount,
        failedAt.toISOString(),
        resolvedAt.toISOString(),
      ],
    );

    // Minimal audit trail
    await pool.query(
      "INSERT INTO recovery_events (case_id, type, payload, created_at) VALUES ($1,$2,$3,$4)",
      [caseId, "INVESTIGATION_STARTED", JSON.stringify({ attemptNo: 1 }), failedAt.toISOString()],
    );
    await pool.query(
      "INSERT INTO recovery_events (case_id, type, payload, created_at) VALUES ($1,$2,$3,$4)",
      [
        caseId,
        "AGENT_PROPOSED",
        JSON.stringify({
          rootCause: "bank_downtime",
          confidence: 0.85,
          toolCalls: 3,
          action: { kind: "PAYMENT_LINK" },
          reasoning: "Customer history clean, bank downtime cleared, payment link successful.",
        }),
        new Date(failedAt.getTime() + 500).toISOString(),
      ],
    );
    await pool.query(
      "INSERT INTO recovery_events (case_id, type, payload, created_at) VALUES ($1,$2,$3,$4)",
      [
        caseId,
        "GATE_APPLIED",
        JSON.stringify({ outcome: "allow", proposed: "PAYMENT_LINK", applied: "PAYMENT_LINK" }),
        new Date(failedAt.getTime() + 600).toISOString(),
      ],
    );
    await pool.query(
      "INSERT INTO recovery_events (case_id, type, payload, created_at) VALUES ($1,$2,$3,$4)",
      [
        caseId,
        "ATTEMPT_OUTCOME",
        JSON.stringify({
          attemptNo: 1,
          status: "RECOVERED",
          recoveredPaise: c.amount,
          razorpayRef: `pay_demo_${caseId.slice(0, 8)}`,
        }),
        resolvedAt.toISOString(),
      ],
    );
    await pool.query(
      "INSERT INTO recovery_events (case_id, type, payload, created_at) VALUES ($1,$2,$3,$4)",
      [
        caseId,
        "CASE_RESOLVED",
        JSON.stringify({ lane: "RECOVERED", via: "executor" }),
        resolvedAt.toISOString(),
      ],
    );
  }

  const totalRecovered = cases.reduce((s, c) => s + c.amount, 0);
  console.log(
    `seeded ${cases.length} historical recovered cases — ₹${Math.round(totalRecovered / 100).toLocaleString("en-IN")} baseline`,
  );
}

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
  console.error(`hero issuer ${downIssuer} (live ${cardDown.severity} downtime)`);

  // Seed historical recovered cases
  await seedHistoricalRecovered(pool, downIssuer);

  // Seed ONE fresh INCOMING hero case (Bank of India downtime)
  const heroCase = {
    id: randomUUID(),
    runId: null,
    merchantRef: "acme_subscriptions",
    customerRef: "cust_demo_gif",
    originalPaymentId: null,
    amountPaise: 149900, // ₹1,499
    currency: "INR",
    failureCode: "BAD_REQUEST_ERROR",
    failureReason: "card_declined",
    failedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    method: "card",
    instrument: { issuer: downIssuer },
    customerHistory: cleanHistory(149900),
  };

  await cases.create(heroCase);
  console.log(`hero case ${heroCase.customerRef.padEnd(14)} ${heroCase.id}`);
  console.log(
    `\nBaseline: ₹10,000 recovered\nAfter hero completes: ₹11,499 recovered (+₹1,499)\n`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
