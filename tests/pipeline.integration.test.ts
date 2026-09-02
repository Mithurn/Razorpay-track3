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
    clock: { now: () => now },
    runAgent: async () => proposal({}),
    ...over,
  });

  beforeAll(async () => {
    db = createPool(adminUrl!);
  });

  afterEach(async () => {
    now = new Date("2026-09-02T09:00:00.000Z");
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

    const events = (await new PostgresEventLog(db).forCase(caseId)).map((e) => e.type);
    expect(events).toEqual(
      expect.arrayContaining(["INVESTIGATION_STARTED", "AGENT_PROPOSED", "GATE_APPLIED", "ATTEMPT_STARTED", "ATTEMPT_OUTCOME", "CASE_RESOLVED"]),
    );
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
    expect(gateEvent!.payload).toMatchObject({ outcome: "clamp", proposed: "RETRY_NOW", applied: "ESCALATE" });
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
        runAgent: async () => proposal({ action: { kind: "PAYMENT_LINK", rail: "card" } }),
      }),
    );
    const outcome = await pipeline.step(caseId);
    expect(outcome.kind).toBe("awaiting_settlement");
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
    const attempt = await new PostgresAttemptRepository(db).byCaseAndNo(caseId, 1);
    expect(attempt).not.toBeNull();
  });
});
