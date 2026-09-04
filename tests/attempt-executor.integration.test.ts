import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { AttemptExecutor } from "../src/execution/attempt-executor.js";
import type { OutcomeResolver, OutcomeVerdict } from "../src/domain/ports.js";
import type { AttemptRequest } from "../src/domain/attempt.js";
import type { GatewayOrder, GatewayPayment, GatewayPaymentLink, PaymentGateway } from "../src/domain/gateway.js";
import { GatewayUnavailableError } from "../src/domain/gateway.js";
import { LoggingNotifier } from "../src/execution/notifier.js";

const adminUrl = process.env.ADMIN_DATABASE_URL;

class FakeGateway implements PaymentGateway {
  orderCreates = 0;
  linkCreates = 0;
  nextCreateThrows: Error | null = null;
  createDelayMs = 0;
  payments: GatewayPayment[] = [];

  async createOrder(input: { amountPaise: number; idempotencyKey: string }): Promise<GatewayOrder> {
    if (this.createDelayMs > 0) await new Promise((r) => setTimeout(r, this.createDelayMs));
    if (this.nextCreateThrows) {
      const e = this.nextCreateThrows;
      this.nextCreateThrows = null;
      throw e;
    }
    this.orderCreates++;
    return { id: `order_fake_${this.orderCreates}`, amountPaise: input.amountPaise };
  }
  async createPaymentLink(input: { amountPaise: number }): Promise<GatewayPaymentLink> {
    this.linkCreates++;
    return { id: `plink_fake_${this.linkCreates}`, url: "https://rzp.io/x", amountPaise: input.amountPaise };
  }
  async getPayment(): Promise<GatewayPayment | null> {
    return null;
  }
  async findOrderByIdempotencyKey(): Promise<GatewayOrder | null> {
    return this.orderCreates ? { id: `order_fake_${this.orderCreates}`, amountPaise: 0 } : null;
  }
  async findPaymentLinkByIdempotencyKey(): Promise<GatewayPaymentLink | null> {
    return null;
  }
  async listOrderPayments(): Promise<GatewayPayment[]> {
    return this.payments;
  }
  async getPaymentLink(): Promise<(GatewayPaymentLink & { payments: GatewayPayment[] }) | null> {
    return null;
  }
  async listDowntimes() {
    return [];
  }
}

class ScriptedResolver implements OutcomeResolver {
  constructor(private verdicts: OutcomeVerdict[]) {}
  async resolve(): Promise<OutcomeVerdict> {
    return this.verdicts.shift() ?? { kind: "pending" };
  }
}

const captured = (paise: number): OutcomeVerdict => ({
  kind: "recovered",
  capturedPaise: paise,
  paymentId: `pay_${randomUUID().slice(0, 8)}`,
});

describe.runIf(adminUrl)("AttemptExecutor", () => {
  let db: Db;
  let caseId: string;

  const request = (over: Partial<AttemptRequest> = {}): AttemptRequest => ({
    caseId,
    attemptNo: 1,
    rootCause: "soft_decline",
    action: { kind: "RETRY_NOW" },
    reasoning: "test",
    amountPaise: 149900,
    currency: "INR",
    scheduledFor: null,
    clamp: null,
    createdAt: new Date().toISOString(),
    ...over,
  });

  const build = (gateway: PaymentGateway, resolver: OutcomeResolver, opts: { reperformAfterMs?: number } = {}) =>
    new AttemptExecutor(
      new PostgresAttemptRepository(db),
      new PostgresEventLog(db),
      gateway,
      resolver,
      new LoggingNotifier(new PostgresEventLog(db)),
      opts,
    );

  beforeAll(async () => {
    db = createPool(adminUrl!);
  });

  afterEach(async () => {
    if (caseId) {
      await db.query("DELETE FROM recovery_events WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_attempts WHERE case_id = $1", [caseId]);
      await db.query("DELETE FROM recovery_cases WHERE id = $1", [caseId]);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  async function seedCase(): Promise<void> {
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
  }

  it("creates one order and records a real capture into the case ledger", async () => {
    await seedCase();
    const gw = new FakeGateway();
    const attempt = await build(gw, new ScriptedResolver([captured(149900)])).execute(request());

    expect(gw.orderCreates).toBe(1);
    expect(attempt.status).toBe("RECOVERED");
    expect(attempt.recoveredPaise).toBe(149900);

    const kase = await new PostgresCaseRepository(db).byId(caseId);
    expect(kase!.recoveredPaise).toBe(149900);
  });

  it("never creates two Razorpay orders for two concurrent calls on the same attempt", async () => {
    await seedCase();
    const gw = new FakeGateway();
    // Widen the window between claim and the winner reaching a terminal state, so a genuinely
    // concurrent second caller's re-read reliably lands while the row is still PENDING — the
    // exact condition the old `attempt.status !== "PENDING"` guard got wrong.
    gw.createDelayMs = 50;
    const exec = build(gw, new ScriptedResolver([captured(149900)]));

    await Promise.all([exec.execute(request()), exec.execute(request())]);

    expect(gw.orderCreates).toBe(1);
    // Only the caller that actually claimed the row performs the attempt; the loser must not.
    const events = await new PostgresEventLog(db).forCase(caseId);
    expect(events.filter((e) => e.type === "ATTEMPT_STARTED")).toHaveLength(1);
  });

  it("is idempotent: executing the same attempt twice creates one order and one credit", async () => {
    await seedCase();
    const gw = new FakeGateway();
    const exec = build(gw, new ScriptedResolver([captured(149900), captured(149900)]));

    await exec.execute(request());
    const second = await exec.execute(request());

    expect(gw.orderCreates).toBe(1);
    expect(second.status).toBe("RECOVERED");
    const kase = await new PostgresCaseRepository(db).byId(caseId);
    expect(kase!.recoveredPaise).toBe(149900);
  });

  it("parks an ambiguous 5xx and never charges twice on the next pass", async () => {
    await seedCase();
    const gw = new FakeGateway();
    gw.nextCreateThrows = new GatewayUnavailableError("razorpay /orders: HTTP 503");
    const exec = build(gw, new ScriptedResolver([captured(149900)]));

    const parked = await exec.execute(request());
    expect(parked.status).toBe("AWAITING_RECONCILIATION");
    expect(gw.orderCreates).toBe(0);

    // The worker retries the job: same attempt, must not create a second order.
    const retried = await exec.execute(request());
    expect(retried.status).toBe("AWAITING_RECONCILIATION");
    expect(gw.orderCreates).toBe(0);
  });

  it("does not append a new ATTEMPT_OUTCOME event when a re-check finds nothing has changed", async () => {
    await seedCase();
    const gw = new FakeGateway();
    gw.nextCreateThrows = new GatewayUnavailableError("timeout");
    const exec = build(gw, new ScriptedResolver([]));
    const repo = new PostgresAttemptRepository(db);
    const events = new PostgresEventLog(db);

    await exec.execute(request());
    const parked = (await repo.listByCase(caseId)).find((a) => a.attemptNo === 1);
    expect(parked!.status).toBe("AWAITING_RECONCILIATION");

    // Three more sweep-style re-checks, each finding the same still-unresolved state.
    await exec.settle(parked!, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" });
    await exec.settle(parked!, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" });
    await exec.settle(parked!, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" });

    const tape = await events.forCase(caseId);
    expect(tape.filter((e) => e.type === "ATTEMPT_OUTCOME")).toHaveLength(1);
  });

  it("settles a parked attempt once the gateway shows a capture, crediting the ledger once", async () => {
    await seedCase();
    const gw = new FakeGateway();
    gw.nextCreateThrows = new GatewayUnavailableError("timeout");
    const repo = new PostgresAttemptRepository(db);
    const exec = build(gw, new ScriptedResolver([captured(149900), captured(149900)]));

    await exec.execute(request());
    const parked = (await repo.listByCase(caseId)).find((a) => a.attemptNo === 1);

    const settled = await exec.settle(parked!, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" });
    expect(settled.status).toBe("RECOVERED");

    const again = await exec.settle(settled, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" });
    expect(again.status).toBe("RECOVERED");

    const kase = await new PostgresCaseRepository(db).byId(caseId);
    expect(kase!.recoveredPaise).toBe(149900);
  });

  it("never demotes a RECOVERED attempt, and never double-credits the case", async () => {
    await seedCase();
    const repo = new PostgresAttemptRepository(db);
    const { attempt } = await repo.claim(request(), `${caseId}:1`);

    const firstCredit = await repo.settleRecovered(attempt.id, 149900, "pay_first");
    expect(firstCredit).toBe(true);

    // A late-arriving ambiguous verdict must not demote the already-settled attempt.
    await repo.resolve(attempt.id, { status: "AWAITING_RECONCILIATION", detail: "late 5xx" });
    const afterResolve = await repo.byId(attempt.id);
    expect(afterResolve!.status).toBe("RECOVERED");
    expect(afterResolve!.recoveredPaise).toBe(149900);

    // A re-settle on the same (now-guarded) row must not credit the case a second time.
    const secondCredit = await repo.settleRecovered(attempt.id, 149900, "pay_second");
    expect(secondCredit).toBe(false);

    const kase = await new PostgresCaseRepository(db).byId(caseId);
    expect(kase!.recoveredPaise).toBe(149900);
  });

  it("records a rejected create as FAILED, not as unknown", async () => {
    await seedCase();
    const gw = new FakeGateway();
    const { GatewayRejectedError } = await import("../src/domain/gateway.js");
    gw.nextCreateThrows = new GatewayRejectedError("amount too small", "input_validation_failed");
    const attempt = await build(gw, new ScriptedResolver([])).execute(request());

    expect(attempt.status).toBe("FAILED");
    expect(attempt.detail).toBe("input_validation_failed");
  });

  it("keeps a not-yet-paid attempt PENDING rather than guessing", async () => {
    await seedCase();
    const gw = new FakeGateway();
    const attempt = await build(gw, new ScriptedResolver([{ kind: "pending" }])).execute(
      request({ action: { kind: "PAYMENT_LINK", rail: "card" } }),
    );
    expect(attempt.status).toBe("PENDING");
    expect(attempt.razorpayRef).toMatch(/^plink_fake_/);
  });

  it("resolves ESCALATE without touching the gateway", async () => {
    await seedCase();
    const gw = new FakeGateway();
    const attempt = await build(gw, new ScriptedResolver([])).execute(
      request({ action: { kind: "ESCALATE", reason: "risk hold" } }),
    );
    expect(attempt.status).toBe("FAILED");
    expect(attempt.detail).toBe("escalated_to_human");
    expect(gw.orderCreates).toBe(0);
  });

  it("re-performs a stale claimed-but-never-performed attempt exactly once", async () => {
    await seedCase();
    const gw = new FakeGateway();
    const exec = build(gw, new ScriptedResolver([captured(149900)]), { reperformAfterMs: 0 });
    const repo = new PostgresAttemptRepository(db);

    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const { attempt, created } = await repo.claim(request({ createdAt: twoHoursAgo }), `${caseId}:1`);
    expect(created).toBe(true);

    const settled = await exec.settle(attempt, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" });
    const again = await exec.settle(settled, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" });

    expect(gw.orderCreates).toBe(1);
    expect(settled.razorpayRef).toMatch(/^order_fake_/);
    expect(settled.status).toBe("RECOVERED");
    expect(again.razorpayRef).toBe(settled.razorpayRef);

    const events = await new PostgresEventLog(db).forCase(caseId);
    expect(events.map((e) => e.type)).toContain("ATTEMPT_REPERFORMED");
  });

  it("re-performs exactly once when two executors race settle() on the same stale attempt", async () => {
    await seedCase();
    const gw = new FakeGateway();
    // Widen the window so both concurrent reperform() calls are genuinely in flight at once —
    // the exact condition the advisory lock in withReperformLock must serialize.
    gw.createDelayMs = 50;
    const resolver = new ScriptedResolver([captured(149900), captured(149900)]);
    // Two separate AttemptExecutor instances, as the real deployment has: one inside
    // RecoveryPipeline (the BullMQ worker path) and one wired directly in main.ts (the webhook
    // HTTP path).
    const execA = build(gw, resolver, { reperformAfterMs: 0 });
    const execB = build(gw, resolver, { reperformAfterMs: 0 });
    const repo = new PostgresAttemptRepository(db);

    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const { attempt, created } = await repo.claim(request({ createdAt: twoHoursAgo }), `${caseId}:1`);
    expect(created).toBe(true);

    const [a, b] = await Promise.all([
      execA.settle(attempt, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" }),
      execB.settle(attempt, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" }),
    ]);

    expect(gw.orderCreates).toBe(1);
    const finalRef = await repo.byId(attempt.id);
    expect(finalRef!.razorpayRef).toMatch(/^order_fake_/);
    // Whichever call lost the race must never disagree with the row that actually landed.
    for (const outcome of [a, b]) {
      if (outcome.razorpayRef) expect(outcome.razorpayRef).toBe(finalRef!.razorpayRef);
    }
  });

  it("parks a fresh claimed-but-never-performed attempt instead of re-performing it", async () => {
    await seedCase();
    const gw = new FakeGateway();
    const exec = build(gw, new ScriptedResolver([]));
    const repo = new PostgresAttemptRepository(db);

    const { attempt, created } = await repo.claim(request(), `${caseId}:1`);
    expect(created).toBe(true);

    const settled = await exec.settle(attempt, { amountPaise: 149900, currency: "INR" }, { kind: "RETRY_NOW" });
    expect(gw.orderCreates).toBe(0);
    expect(settled.status).toBe("PENDING");
  });

  it("closes a claimed-but-never-performed ESCALATE that a crash left pending", async () => {
    await seedCase();
    const gw = new FakeGateway();
    const exec = build(gw, new ScriptedResolver([]));
    const repo = new PostgresAttemptRepository(db);

    const { attempt, created } = await repo.claim(
      request({ action: { kind: "ESCALATE", reason: "risk hold" } }),
      `${caseId}:1`,
    );
    expect(created).toBe(true);

    const settled = await exec.settle(attempt, { amountPaise: 149900, currency: "INR" }, {
      kind: "ESCALATE",
      reason: "risk hold",
    });
    expect(gw.orderCreates).toBe(0);
    expect(settled.status).toBe("FAILED");
    expect(settled.detail).toBe("escalated_to_human");
  });

  it("writes a full event tape for one attempt under the case id", async () => {
    await seedCase();
    const attempt = await build(new FakeGateway(), new ScriptedResolver([captured(149900)])).execute(request());
    expect(attempt.status).toBe("RECOVERED");

    const events = await new PostgresEventLog(db).forCase(caseId);
    const types = events.map((e) => e.type);
    expect(types).toContain("ATTEMPT_STARTED");
    expect(types).toContain("ATTEMPT_OUTCOME");
  });
});
