import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { RazorpayClient } from "../src/execution/razorpay-client.js";
import type { Pool } from "pg";
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

type H = {
  daysAgo: number; cust: string; amount: number; reason: string;
  issuer: string; lane: string; action: string; outcome: string; hrs: number;
};

async function ins(pool: Pool, caseId: string, type: string, payload: unknown, at: string) {
  await pool.query(
    "INSERT INTO recovery_events (case_id, type, payload, created_at) VALUES ($1, $2, $3, $4)",
    [caseId, type, JSON.stringify(payload), at],
  );
}

async function seedEvents(pool: Pool, caseId: string, h: H, failedAt: Date, resolvedAt: Date | null) {
  const t = (ms: number) => new Date(failedAt.getTime() + ms).toISOString();

  const rootCause =
    h.reason === "card_declined"             ? "bank_downtime"      :
    h.reason === "insufficient_funds"        ? "insufficient_funds" :
    h.reason === "card_expired"              ? "hard_decline"       :
    h.reason === "soft_decline"              ? "soft_decline"       :
    h.reason === "payment_risk_check_failed" ? "risk_hold"          : "soft_decline";

  const confidence = h.outcome === "RECOVERED" ? 0.82 + Math.random() * 0.14 :
    h.lane === "ESCALATED" ? 0.88 + Math.random() * 0.10 : 0.71 + Math.random() * 0.15;

  const reasoning =
    h.action === "PAYMENT_LINK"
      ? "Customer has 4 prior successful payments. Similar cases on this failure code recovered via payment link within 2h. No issuer-specific downtime matched — sending link is the lowest-friction path."
      : h.action === "RETRY_SCHEDULED"
      ? "Customer history is clean. Failure appears transient or issuer-side. Scheduling retry after the typical recovery window."
      : h.action === "ESCALATE"
      ? "Payment risk flag is active. Automated retry is not safe here — escalating for human review."
      : h.action === "CUSTOMER_NUDGE"
      ? "Card is expired. No automatic retry will succeed. Customer must update payment method."
      : "No recoverable path found given customer history and failure pattern.";

  await ins(pool, caseId, "INVESTIGATION_STARTED", { attemptNo: 1 }, t(500));

  const c1 = randomUUID();
  await ins(pool, caseId, "TOOL_CALLED", { callId: c1, name: "get_customer_payment_history" }, t(800));
  await ins(pool, caseId, "TOOL_RESULT", {
    callId: c1, source: "local",
    raw: { totalPayments: 4, successfulPayments: 4, failedPayments: 0, daysSinceLastSuccess: h.reason === "insufficient_funds" ? 32 : 14, medianDaysBetweenPayments: 30 },
  }, t(1100));

  if (h.action !== "ESCALATE" && h.action !== "WRITE_OFF") {
    const c2 = randomUUID();
    await ins(pool, caseId, "TOOL_CALLED", { callId: c2, name: "get_recovery_playbook" }, t(1400));
    await ins(pool, caseId, "TOOL_RESULT", { callId: c2, source: "local", raw: { playbook: [{ rootCause, defaultAction: h.action }] } }, t(1700));
  }

  if (h.reason === "card_declined" && h.action === "PAYMENT_LINK") {
    const c3 = randomUUID();
    await ins(pool, caseId, "TOOL_CALLED", { callId: c3, name: "get_similar_resolved_cases" }, t(2000));
    await ins(pool, caseId, "TOOL_RESULT", {
      callId: c3, source: "local",
      raw: { failureReason: "card_declined", cases: [{ action: "PAYMENT_LINK", outcome: "RECOVERED", hoursToResolution: 1.2 }] },
    }, t(2400));
  }

  if (h.reason === "card_declined") {
    const c4 = randomUUID();
    await ins(pool, caseId, "TOOL_CALLED", { callId: c4, name: "check_bank_downtime" }, t(2700));
    await ins(pool, caseId, "TOOL_RESULT", {
      callId: c4, source: "razorpay-live",
      raw: { matched: false, activeDowntimes: [], methodWideOutages: [] },
    }, t(3200));
  }

  const toolCalls = h.reason === "card_declined" ? 4 : h.action === "ESCALATE" ? 1 : 2;
  await ins(pool, caseId, "AGENT_PROPOSED", {
    rootCause, confidence, toolCalls,
    action: { kind: h.action },
    reasoning,
  }, t(3800));

  await ins(pool, caseId, "GATE_APPLIED", {
    outcome: "allow", proposed: h.action, applied: h.action, rule: null, detail: null,
  }, t(3900));

  if (h.lane === "ESCALATED") {
    await ins(pool, caseId, "CASE_RESOLVED", { lane: "ESCALATED", via: "gate" }, t(4100));
    return;
  }

  await ins(pool, caseId, "ATTEMPT_STARTED", { attemptNo: 1, action: { kind: h.action }, clamped: false }, t(4200));

  if (h.outcome === "PENDING") return;

  const resolveMs = resolvedAt ? resolvedAt.getTime() - failedAt.getTime() : 5000;
  const finalStatus = h.outcome === "RECOVERED" ? "RECOVERED" : "FAILED";
  await ins(pool, caseId, "ATTEMPT_OUTCOME", {
    attemptNo: 1, status: finalStatus,
    recoveredPaise: h.outcome === "RECOVERED" ? h.amount : 0,
    razorpayRef: h.outcome === "RECOVERED" ? `pay_demo${caseId.slice(0, 8)}` : null,
  }, t(resolveMs));

  const finalLane = h.outcome === "RECOVERED" ? "RECOVERED" : "WRITTEN_OFF";
  await ins(pool, caseId, "CASE_RESOLVED", { lane: finalLane, via: "executor" }, t(resolveMs + 100));
}

async function seedHistoricalResolved(pool: Pool, upIssuer: string): Promise<void> {
  const now = Date.now();
  const day = 24 * 60 * 60_000;

  const rows: H[] = [
    // RECOVERED — card_declined, PAYMENT_LINK pattern agent should notice
    { daysAgo: 14, cust: "cust_1001", amount: 149900,  reason: "card_declined",            issuer: upIssuer, lane: "RECOVERED",        action: "PAYMENT_LINK",    outcome: "RECOVERED", hrs: 1.1 },
    { daysAgo: 13, cust: "cust_1002", amount: 299900,  reason: "card_declined",            issuer: upIssuer, lane: "RECOVERED",        action: "PAYMENT_LINK",    outcome: "RECOVERED", hrs: 0.8 },
    { daysAgo: 12, cust: "cust_1003", amount: 49900,   reason: "card_declined",            issuer: upIssuer, lane: "RECOVERED",        action: "PAYMENT_LINK",    outcome: "RECOVERED", hrs: 2.3 },
    { daysAgo: 11, cust: "cust_1004", amount: 999900,  reason: "card_declined",            issuer: upIssuer, lane: "RECOVERED",        action: "PAYMENT_LINK",    outcome: "RECOVERED", hrs: 1.5 },
    { daysAgo:  9, cust: "cust_1005", amount: 149900,  reason: "card_declined",            issuer: upIssuer, lane: "RECOVERED",        action: "RETRY_SCHEDULED", outcome: "RECOVERED", hrs: 4.0 },
    { daysAgo:  7, cust: "cust_1006", amount: 199900,  reason: "card_declined",            issuer: upIssuer, lane: "RECOVERED",        action: "PAYMENT_LINK",    outcome: "RECOVERED", hrs: 1.2 },
    { daysAgo:  5, cust: "cust_1007", amount: 499900,  reason: "card_declined",            issuer: upIssuer, lane: "RECOVERED",        action: "PAYMENT_LINK",    outcome: "RECOVERED", hrs: 0.9 },
    // RECOVERED — insufficient_funds
    { daysAgo: 13, cust: "cust_1008", amount: 249900,  reason: "insufficient_funds",       issuer: upIssuer, lane: "RECOVERED",        action: "RETRY_SCHEDULED", outcome: "RECOVERED", hrs: 28.0 },
    { daysAgo: 10, cust: "cust_1009", amount: 99900,   reason: "insufficient_funds",       issuer: "ICIC",   lane: "RECOVERED",        action: "RETRY_SCHEDULED", outcome: "RECOVERED", hrs: 47.0 },
    { daysAgo:  8, cust: "cust_1010", amount: 599900,  reason: "insufficient_funds",       issuer: upIssuer, lane: "RECOVERED",        action: "RETRY_SCHEDULED", outcome: "RECOVERED", hrs: 25.0 },
    { daysAgo:  6, cust: "cust_1011", amount: 149900,  reason: "insufficient_funds",       issuer: "SBIN",   lane: "RECOVERED",        action: "RETRY_SCHEDULED", outcome: "RECOVERED", hrs: 51.0 },
    // RECOVERED — card_expired
    { daysAgo: 12, cust: "cust_1012", amount: 349900,  reason: "card_expired",             issuer: "ICIC",   lane: "RECOVERED",        action: "CUSTOMER_NUDGE",  outcome: "RECOVERED", hrs: 72.0 },
    { daysAgo:  7, cust: "cust_1013", amount: 149900,  reason: "card_expired",             issuer: upIssuer, lane: "RECOVERED",        action: "PAYMENT_LINK",    outcome: "RECOVERED", hrs: 36.0 },
    // RECOVERED — soft_decline
    { daysAgo: 11, cust: "cust_1014", amount: 79900,   reason: "soft_decline",             issuer: upIssuer, lane: "RECOVERED",        action: "RETRY_NOW",       outcome: "RECOVERED", hrs: 0.2 },
    { daysAgo:  4, cust: "cust_1015", amount: 149900,  reason: "soft_decline",             issuer: "UTIB",   lane: "RECOVERED",        action: "RETRY_NOW",       outcome: "RECOVERED", hrs: 0.1 },
    // ESCALATED — risk holds
    { daysAgo:  2, cust: "cust_1016", amount: 449900,  reason: "payment_risk_check_failed",issuer: upIssuer, lane: "ESCALATED",        action: "ESCALATE",        outcome: "PENDING",   hrs: 0   },
    { daysAgo:  1, cust: "cust_1017", amount: 1299900, reason: "payment_risk_check_failed",issuer: "ICIC",   lane: "ESCALATED",        action: "ESCALATE",        outcome: "PENDING",   hrs: 0   },
    { daysAgo:  1, cust: "cust_1018", amount: 249900,  reason: "card_declined",            issuer: upIssuer, lane: "ESCALATED",        action: "ESCALATE",        outcome: "PENDING",   hrs: 0   },
    // WRITTEN_OFF
    { daysAgo:  6, cust: "cust_1019", amount: 49900,   reason: "card_declined",            issuer: "SBIN",   lane: "WRITTEN_OFF",      action: "WRITE_OFF",       outcome: "FAILED",    hrs: 0   },
    { daysAgo:  4, cust: "cust_1020", amount: 99900,   reason: "insufficient_funds",       issuer: "PUNB",   lane: "WRITTEN_OFF",      action: "WRITE_OFF",       outcome: "FAILED",    hrs: 0   },
    { daysAgo:  3, cust: "cust_1021", amount: 299900,  reason: "card_expired",             issuer: upIssuer, lane: "WRITTEN_OFF",      action: "WRITE_OFF",       outcome: "FAILED",    hrs: 0   },
    // RETRY_SCHEDULED — pending
    { daysAgo:  0, cust: "cust_1022", amount: 149900,  reason: "insufficient_funds",       issuer: "KKBK",   lane: "RETRY_SCHEDULED",  action: "RETRY_SCHEDULED", outcome: "PENDING",   hrs: 0   },
    { daysAgo:  0, cust: "cust_1023", amount: 249900,  reason: "soft_decline",             issuer: upIssuer, lane: "RETRY_SCHEDULED",  action: "RETRY_SCHEDULED", outcome: "PENDING",   hrs: 0   },
  ];

  for (let i = 0; i < rows.length; i++) {
    const h = rows[i]!;
    const failedAt = new Date(now - h.daysAgo * day - Math.floor(Math.random() * 6 * 60 * 60_000));
    const resolvedAt = h.hrs > 0 ? new Date(failedAt.getTime() + h.hrs * 3_600_000) : null;
    const caseId = randomUUID();
    const attemptId = randomUUID();
    const recoveredPaise = h.outcome === "RECOVERED" ? h.amount : 0;
    const terminalOutcome = h.outcome === "RECOVERED" ? "RECOVERED" : h.outcome === "FAILED" ? "FAILED" : "PENDING";

    await pool.query(
      `INSERT INTO recovery_cases
         (id, run_id, merchant_ref, customer_ref, original_payment_id,
          amount_paise, currency, failure_code, failure_reason, failed_at,
          method, instrument, customer_history, lane, recovered_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        caseId, null, "acme_subscriptions", h.cust, null,
        h.amount, "INR", "BAD_REQUEST_ERROR", h.reason,
        failedAt.toISOString(), "card",
        JSON.stringify({ issuer: h.issuer }),
        JSON.stringify([]),
        h.lane, recoveredPaise,
      ],
    );

    await pool.query(
      `INSERT INTO recovery_attempts
         (id, case_id, attempt_no, root_cause, action, idempotency_key,
          outcome, recovered_paise, created_at, resolved_at)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9)`,
      [
        attemptId, caseId,
        h.reason === "card_declined" ? "bank_downtime" : h.reason === "payment_risk_check_failed" ? "risk_hold" : h.reason,
        h.action, `hist-${i}-${caseId}`,
        terminalOutcome, recoveredPaise,
        failedAt.toISOString(), resolvedAt?.toISOString() ?? null,
      ],
    );

    await seedEvents(pool, caseId, h, failedAt, resolvedAt);
  }

  const totalRecovered = rows.filter(r => r.outcome === "RECOVERED").reduce((s, r) => s + r.amount, 0);
  console.log(`seeded ${rows.length} historical cases — ₹${Math.round(totalRecovered / 100).toLocaleString("en-IN")} recovered`);
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
  const upIssuer = ["HDFC", "ICIC", "AXIS"].find((i) => i !== downIssuer) ?? "HDFC";
  console.error(`hero issuer ${downIssuer} (live ${cardDown.severity} downtime); control issuer ${upIssuer}`);

  const base = 149900;
  const seeds: NewCase[] = [
    {
      id: randomUUID(),
      runId: null,
      merchantRef: "acme_subscriptions",
      customerRef: "cust_1024",
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
      customerRef: "cust_1025",
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
      customerRef: "cust_1026",
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
      customerRef: "cust_1027",
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

  await seedHistoricalResolved(pool, upIssuer);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
