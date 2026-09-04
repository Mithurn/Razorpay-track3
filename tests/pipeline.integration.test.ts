import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { RecoveryPipeline, type PipelineDeps } from "../src/worker/pipeline.js";
import type { AgentProposal } from "../src/domain/recovery-action.js";
import type { OutcomeResolver, OutcomeVerdict } from "../src/domain/ports.js";
import type { GatewayOrder, GatewayPayment, GatewayPaymentLink, PaymentGateway } from "../src/domain/gateway.js";
import { isRiskHold } from "../src/domain/case.js";
import { LoggingNotifier } from "../src/execution/notifier.js";

const adminUrl = process.env.ADMIN_DATABASE_URL;

class FakeGateway implements PaymentGateway {
  orders = 0;
  async createOrder(i: { amountPaise: number }): Promise<GatewayOrder> {
    this.orders++;
    return { id: `order_${this.orders}`, amountPaise: i.amountPaise };
  }
  async createPaymentLink(i: { amountPaise: number }): Promise<GatewayPaymentLink> {
    return { id: "plink_1", url: "x", amountPaise: i.amountPaise };
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

const proposal = (over: Partial<AgentProposal>): AgentProposal => ({
  action: { kind: "RETRY_SCHEDULED", atHoursFromNow: 48 },
  diagnosisRootCause: "soft_decline",
  confidence: 0.7,
  reasoning: "one scheduled retry should clear a soft decline",
  toolCalls: 2,
  degraded: false,
  ...over,
});

class ScriptedResolver implements OutcomeResolver {
  constructor(private verdicts: OutcomeVerdict[]) {}
  async resolve(): Promise<OutcomeVerdict> {
    return this.verdicts.shift() ?? { kind: "pending" };
  }
}

describe.runIf(adminUrl)("RecoveryPipeline", () => {
  let db: Db;
  let caseId: string;
  let now = new Date("2026-09-02T09:00:00.000Z");

  const baseDeps = (over: Partial<PipelineDeps>): PipelineDeps => ({
    cases: new PostgresCaseRepository(db),
    attempts: new PostgresAttemptRepository(db),
    events: new PostgresEventLog(db),
    gateway: new FakeGateway(),
    outcomeResolver: new ScriptedResolver([{ kind: "pending" }]),
    notifier: new LoggingNotifier(new PostgresEventLog(db)),
    clock: { now: () => now },
    riskHoldForCase: isRiskHold,
    runAgent: async () => proposal({}),
    ...over,
  });

  beforeAll(async () => {
    db = createPool(adminUrl!);
  });

  afterEach(async () => {
    now = new Date("2026-09-02T09:00:00.000Z");
    await db.query("DELETE FROM recovery_attempts WHERE case_id IN (SELECT id FROM recovery_cases WHERE customer_ref = 'similar-test')");
    await db.query("DELETE FROM recovery_cases WHERE customer_ref = 'similar-test'");
    if (caseId) {
      await db.query("DELETE FROM recovery_events WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_attempts WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_cases WHERE id = $1", [caseId]);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  async function seed(over: Partial<Parameters<PostgresCaseRepository["create"]>[0]> = {}): Promise<void> {
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
      failedAt: now.toISOString(),
      method: "card",
      instrument: { issuer: "BKID" },
      customerHistory: [],
      ...over,
    });
  }

  it("runs diagnose -> gate -> attempt -> recovered and credits the real capture", async () => {
    await seed();
    const gw = new FakeGateway();
    const pipeline = new RecoveryPipeline(
      baseDeps({
        gateway: gw,
        outcomeResolver: new ScriptedResolver([{ kind: "recovered", capturedPaise: 149900, paymentId: "pay_1" }]),
        runAgent: async () => proposal({ action: { kind: "RETRY_NOW" } }),
      }),
    );

    const outcome = await pipeline.step(caseId);
    expect(outcome).toEqual({ kind: "resolved", lane: "RECOVERED" });

    const kase = await new PostgresCaseRepository(db).byId(caseId);
    expect(kase!.lane).toBe("RECOVERED");
    expect(kase!.recoveredPaise).toBe(149900);
    expect(gw.orders).toBe(1);

    const recorded = await new PostgresEventLog(db).forCase(caseId);
    expect(recorded.map((e) => e.type)).toEqual(
      expect.arrayContaining(["INVESTIGATION_STARTED", "AGENT_PROPOSED", "GATE_APPLIED", "ATTEMPT_STARTED", "ATTEMPT_OUTCOME", "CASE_RESOLVED"]),
    );
    // A guardrail's absence is structured too — no rule fired, so both are explicitly null, not
    // simply missing from the payload.
    const gateEvent = recorded.find((e) => e.type === "GATE_APPLIED");
    expect(gateEvent!.payload).toMatchObject({ outcome: "allow", rule: null, detail: null, proposed: "RETRY_NOW", applied: "RETRY_NOW" });
  });

  it("resolves a case whose money already settled instead of re-investigating it", async () => {
    await seed();
    let agentRuns = 0;
    const pipeline = new RecoveryPipeline(
      baseDeps({
        runAgent: async () => {
          agentRuns++;
          return proposal({});
        },
      }),
    );
    const attempts = new PostgresAttemptRepository(db);

    const { attempt, created } = await attempts.claim(
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
    expect(created).toBe(true);
    await attempts.settleRecovered(attempt.id, 149900, "pay_already_settled");
    await new PostgresCaseRepository(db).moveLane(caseId, "INCOMING", "ATTEMPTING");

    const outcome = await pipeline.advance(caseId);

    expect(outcome).toEqual({ kind: "resolved", lane: "RECOVERED" });
    expect(agentRuns).toBe(0);
    expect((await new PostgresCaseRepository(db).byId(caseId))!.lane).toBe("RECOVERED");
  });

  it("routes a risk-flagged proposal to ESCALATED without moving money", async () => {
    await seed();
    const gw = new FakeGateway();
    const pipeline = new RecoveryPipeline(
      baseDeps({
        gateway: gw,
        runAgent: async () =>
          proposal({ diagnosisRootCause: "risk_hold", action: { kind: "RETRY_NOW" } }),
      }),
    );

    const outcome = await pipeline.step(caseId);
    expect(outcome).toEqual({ kind: "resolved", lane: "ESCALATED" });
    expect(gw.orders).toBe(0);

    const gateEvent = (await new PostgresEventLog(db).forCase(caseId)).find((e) => e.type === "GATE_APPLIED");
    expect(gateEvent!.payload).toMatchObject({
      outcome: "clamp",
      proposed: "RETRY_NOW",
      applied: "ESCALATE",
      rule: "risk_hold",
    });
  });

  it("escalates a risk-hold case even when the agent misdiagnoses it", async () => {
    await seed({ failureReason: "payment_risk_check_failed" });
    const gw = new FakeGateway();
    const pipeline = new RecoveryPipeline(
      baseDeps({
        gateway: gw,
        runAgent: async () =>
          proposal({ diagnosisRootCause: "soft_decline", action: { kind: "RETRY_NOW" } }),
      }),
    );

    const outcome = await pipeline.step(caseId);
    expect(outcome).toEqual({ kind: "resolved", lane: "ESCALATED" });
    expect(gw.orders).toBe(0);

    const gateEvent = (await new PostgresEventLog(db).forCase(caseId)).find((e) => e.type === "GATE_APPLIED");
    expect(gateEvent!.payload).toMatchObject({
      outcome: "clamp",
      proposed: "RETRY_NOW",
      applied: "ESCALATE",
      rule: "risk_hold",
      activity: "gate",
    });
    expect(typeof (gateEvent!.payload as { detail: unknown }).detail).toBe("string");
  });

  it("reschedules a failed attempt, then escalates once the cap is reached", async () => {
    await seed();
    const gw = new FakeGateway();
    const deps = baseDeps({
      gateway: gw,
      outcomeResolver: new ScriptedResolver(Array(5).fill({ kind: "failed", detail: "still declined" })),
      runAgent: async () => proposal({ action: { kind: "RETRY_NOW" } }),
    });
    const pipeline = new RecoveryPipeline(deps);

    for (let i = 0; i < 3; i++) {
      const out = await pipeline.step(caseId);
      expect(out.kind).toBe("reschedule");
      now = new Date(now.getTime() + 24 * 3_600_000);
    }
    const final = await pipeline.step(caseId);
    expect(final).toEqual({ kind: "resolved", lane: "ESCALATED" });

    const attempts = await new PostgresAttemptRepository(db).listByCase(caseId);
    expect(attempts).toHaveLength(4);
    expect(gw.orders).toBe(4);
  });

  it("holds a payment-link attempt as awaiting settlement rather than guessing", async () => {
    await seed();
    const pipeline = new RecoveryPipeline(
      baseDeps({
        outcomeResolver: new ScriptedResolver([{ kind: "pending" }]),
    notifier: new LoggingNotifier(new PostgresEventLog(db)),
        runAgent: async () => proposal({ action: { kind: "PAYMENT_LINK", rail: "card" } }),
      }),
    );
    const outcome = await pipeline.step(caseId);
    expect(outcome.kind).toBe("awaiting_settlement");
  });

  it("runs exactly one cycle when two workers pick up the same case at once", async () => {
    await seed();
    let agentRuns = 0;
    const pipeline = new RecoveryPipeline(
      baseDeps({
        outcomeResolver: new ScriptedResolver([{ kind: "pending" }]),
    notifier: new LoggingNotifier(new PostgresEventLog(db)),
        runAgent: async () => {
          agentRuns++;
          await new Promise((r) => setTimeout(r, 50));
          return proposal({ action: { kind: "ESCALATE", reason: "manual review" } });
        },
      }),
    );

    const [a, b] = await Promise.all([pipeline.advance(caseId), pipeline.advance(caseId)]);
    expect([a.kind, b.kind].sort()).toEqual(["not_claimed", "resolved"]);
    expect(agentRuns).toBe(1);

    const types = (await new PostgresEventLog(db).forCase(caseId)).map((e) => e.type);
    expect(types.filter((t) => t === "INVESTIGATION_STARTED")).toHaveLength(1);
    expect(types.filter((t) => t === "CASE_RESOLVED")).toHaveLength(1);
  });

  it("degraded proposal still passes through the gate and is recorded as degraded", async () => {
    await seed();
    const pipeline = new RecoveryPipeline(
      baseDeps({
        outcomeResolver: new ScriptedResolver([{ kind: "failed", detail: "declined" }]),
        runAgent: async () =>
          proposal({ degraded: true, diagnosisRootCause: null, action: { kind: "RETRY_SCHEDULED", atHoursFromNow: 48 } }),
      }),
    );
    await pipeline.step(caseId);
    const events = (await new PostgresEventLog(db).forCase(caseId)).map((e) => e.type);
    expect(events).toContain("AGENT_DEGRADED");
    const attempt = (await new PostgresAttemptRepository(db).listByCase(caseId)).find((a) => a.attemptNo === 1);
    expect(attempt).not.toBeNull();

    // The attempt row is an audit record. A loop that never reached a diagnosis must say so —
    // it used to default to "technical", which the eval then scored as a correct diagnosis.
    expect(attempt!.rootCause).toBeNull();
    const { rows } = await db.query("SELECT root_cause FROM recovery_attempts WHERE case_id = $1", [caseId]);
    expect(rows[0]!.root_cause).toBeNull();
  });

  // A nudge has no order and no link, so nothing can ever settle it. It used to sit PENDING and
  // re-check every two hours forever. This drives it in the live shape — a resolver that only
  // ever says "pending", exactly like RazorpayOutcomeResolver does for a nudge.
  it("ends a nudge instead of re-checking it forever, and records that nothing was delivered", async () => {
    await seed({ failureReason: "card_expired" });
    const pipeline = new RecoveryPipeline(
      baseDeps({
        outcomeResolver: { resolve: async () => ({ kind: "pending" as const }) },
        runAgent: async () => proposal({ action: { kind: "CUSTOMER_NUDGE", channel: "email" }, diagnosisRootCause: "hard_decline" }),
        // 10:00 UTC is 15:30 IST — inside the RBI contact window, so the nudge is not skipped.
      }),
    );

    const outcome = await pipeline.step(caseId);
    expect(outcome.kind).not.toBe("awaiting_settlement");

    const attempt = (await new PostgresAttemptRepository(db).listByCase(caseId)).find((a) => a.attemptNo === 1);
    expect(attempt?.status).toBe("FAILED");
    expect(attempt?.detail).toContain("not observable");

    const events = await new PostgresEventLog(db).forCase(caseId);
    const queued = events.find((e) => e.type === "NUDGE_QUEUED");
    expect(queued).toBeDefined();
    // Nothing downstream may read this as a delivered message.
    expect(queued!.payload).toMatchObject({ channel: "email", delivered: false });
  });

  // The escalation rail used to be a dead end: a human clicked, the agent re-ran, and the gate
  // re-vetoed for the same reason the case escalated. These two pin the fix at both ends.
  describe("human directive on an escalated case", () => {
    async function directive(action: unknown): Promise<void> {
      await new PostgresEventLog(db).append({
        caseId,
        type: "HUMAN_DIRECTIVE",
        payload: { action, approver: "ops@acme.test", at: now.toISOString(), note: null },
      });
    }

    it("performs the human's action on a risk hold the agent could never have retried, without re-running the agent", async () => {
      await seed({ failureReason: "payment_risk_check_failed" });
      await directive({ kind: "PAYMENT_LINK", rail: "card" });

      let agentRan = false;
      const pipeline = new RecoveryPipeline(
        baseDeps({
          runAgent: async () => {
            agentRan = true;
            return proposal({});
          },
        }),
      );
      await pipeline.step(caseId);

      expect(agentRan).toBe(false);
      const attempt = (await new PostgresAttemptRepository(db).listByCase(caseId)).find((a) => a.attemptNo === 1);
      expect(attempt?.action).toBe("PAYMENT_LINK");
      // No model produced this, so there is no diagnosis to claim.
      expect(attempt?.rootCause).toBeNull();

      const types = (await new PostgresEventLog(db).forCase(caseId)).map((e) => e.type);
      expect(types).toContain("AGENT_SKIPPED_HUMAN_DIRECTED");
      expect(types).not.toContain("AGENT_PROPOSED");
    });

    // Regression: an ESCALATE attempt never touches Razorpay, but the cooldown clock used to
    // start ticking from it anyway (a filter that checked only status, never the action's kind).
    // A human directive issued right after an escalation would then get parked for
    // cooldownHours regardless of what was decided — found live, driving the actual demo.
    it("does not let the escalation itself arm the charge cooldown against the human's next move", async () => {
      await seed({ failureReason: "payment_risk_check_failed" });
      const gw = new FakeGateway();

      // First turn: the agent escalates a risk hold, same as production. This attempt moves no
      // money and must not count as "the last charge" for cooldown purposes.
      const pipeline = new RecoveryPipeline(
        baseDeps({ gateway: gw, runAgent: async () => proposal({ diagnosisRootCause: "risk_hold", action: { kind: "ESCALATE", reason: "risk" } }) }),
      );
      expect(await pipeline.step(caseId)).toEqual({ kind: "resolved", lane: "ESCALATED" });

      // A human directs a payment link immediately after — no wall-clock gap at all.
      await directive({ kind: "PAYMENT_LINK", rail: "card" });
      const outcome = await pipeline.step(caseId);

      expect(outcome.kind).not.toBe("reschedule");
      expect(gw.orders).toBe(0); // a link, not an order
      const attempt = (await new PostgresAttemptRepository(db).listByCase(caseId)).find((a) => a.attemptNo === 2);
      expect(attempt?.action).toBe("PAYMENT_LINK");
    });

    it("still refuses a hard decline the human tried to auto-reattempt", async () => {
      await seed({ failureReason: "card_expired" });
      await directive({ kind: "RETRY_NOW" });

      const gw = new FakeGateway();
      const pipeline = new RecoveryPipeline(
        baseDeps({ gateway: gw, hardDeclineForCase: () => true, runAgent: async () => proposal({}) }),
      );
      const outcome = await pipeline.step(caseId);

      // A card-network fine is not the merchant's to waive, authorization or not.
      expect(outcome).toEqual({ kind: "resolved", lane: "ESCALATED" });
      expect(gw.orders).toBe(0);
      const attempt = (await new PostgresAttemptRepository(db).listByCase(caseId)).find((a) => a.attemptNo === 1);
      expect(attempt?.action).toBe("ESCALATE");
    });
  });

  it("similarResolved returns settled attempts of earlier resolved cases with the same reason", async () => {
    const reason = "card_declined_" + randomUUID().slice(0, 8);
    await seed({ failureReason: reason });
    const settledCase = randomUUID();
    const otherMethod = randomUUID();
    const otherReason = randomUUID();
    for (const [id, method, caseReason] of [
      [settledCase, "card", reason],
      [otherMethod, "netbanking", reason],
      [otherReason, "card", "insufficient_funds"],
    ] as const) {
      await db.query(
        `INSERT INTO recovery_cases (id, merchant_ref, customer_ref, amount_paise, currency,
           failure_code, failure_reason, failed_at, method, lane)
         VALUES ($1, 'm', 'similar-test', 149900, 'INR', 'BAD_REQUEST_ERROR', $2,
           $3::timestamptz - interval '48h', $4, 'RECOVERED')`,
        [id, caseReason, now.toISOString(), method],
      );
    }
    await db.query(
      `INSERT INTO recovery_attempts (id, case_id, attempt_no, root_cause, action, idempotency_key,
         outcome, resolved_at)
       VALUES
         ($1, $4, 1, 'soft_decline', 'RETRY_NOW', 'k1', 'FAILED', NULL),
         ($2, $4, 2, 'soft_decline', 'PAYMENT_LINK', 'k2', 'RECOVERED',
           $3::timestamptz - interval '48h' + interval '5h'),
         ($5, $6, 1, 'soft_decline', 'PAYMENT_LINK', 'k3', 'RECOVERED', NULL)`,
      [randomUUID(), randomUUID(), now.toISOString(), settledCase, randomUUID(), otherMethod],
    );

    const repo = new PostgresCaseRepository(db);
    const all = await repo.similarResolved(reason, {
      method: null,
      beforeFailedAt: now.toISOString(),
      runId: null,
      limit: 8,
    });
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.outcome === "RECOVERED" && r.hoursToResolution !== null)).toEqual([
      { failureReason: reason, action: "PAYMENT_LINK", outcome: "RECOVERED", hoursToResolution: 5 },
    ]);

    const cardsOnly = await repo.similarResolved(reason, {
      method: "card",
      beforeFailedAt: now.toISOString(),
      runId: null,
      limit: 8,
    });
    expect(cardsOnly).toHaveLength(2);
  });
});
