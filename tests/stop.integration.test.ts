import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { RecoveryPipeline, type PipelineDeps } from "../src/worker/pipeline.js";
import { InMemoryStopStore } from "../src/worker/stop-registry.js";
import type { AgentProposal } from "../src/domain/recovery-action.js";
import type { OutcomeResolver, OutcomeVerdict } from "../src/domain/ports.js";
import type { GatewayOrder, GatewayPayment, GatewayPaymentLink, PaymentGateway } from "../src/domain/gateway.js";
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

class ScriptedResolver implements OutcomeResolver {
  constructor(private verdicts: OutcomeVerdict[]) {}
  async resolve(): Promise<OutcomeVerdict> {
    return this.verdicts.shift() ?? { kind: "pending" };
  }
}

const proposal: AgentProposal = {
  action: { kind: "RETRY_NOW" },
  diagnosisRootCause: "soft_decline",
  confidence: 0.9,
  reasoning: "a retry should clear this",
  toolCalls: 1,
  degraded: false,
};

describe.runIf(adminUrl)("RecoveryPipeline stop", () => {
  let db: Db;
  const seededIds: string[] = [];

  const seed = async (): Promise<string> => {
    const id = randomUUID();
    seededIds.push(id);
    await new PostgresCaseRepository(db).create({
      id,
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
    return id;
  };

  beforeAll(async () => {
    db = createPool(adminUrl!);
  });

  afterEach(async () => {
    for (const id of seededIds.splice(0)) {
      await db.query("DELETE FROM recovery_events WHERE case_id = $1", [id]);
      await db.query("DELETE FROM recovery_attempts WHERE case_id = $1", [id]);
      await db.query("DELETE FROM recovery_cases WHERE id = $1", [id]);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  const baseDeps = (stopRegistry: InMemoryStopStore, runAgent: PipelineDeps["runAgent"], gateway = new FakeGateway()): PipelineDeps => ({
    cases: new PostgresCaseRepository(db),
    attempts: new PostgresAttemptRepository(db),
    events: new PostgresEventLog(db),
    gateway,
    outcomeResolver: new ScriptedResolver([{ kind: "pending" }]),
    notifier: new LoggingNotifier(new PostgresEventLog(db)),
    clock: { now: () => new Date() },
    runAgent,
    stopRegistry,
  });

  it("requestStop resolves an idle case to STOPPED without ever calling the agent", async () => {
    const id = await seed();
    let agentCalled = false;
    const stopRegistry = new InMemoryStopStore();
    const pipeline = new RecoveryPipeline(
      baseDeps(stopRegistry, async () => {
        agentCalled = true;
        return proposal;
      }),
    );

    await pipeline.requestStop(id, { reason: "user_requested", note: "testing" });

    const kase = await new PostgresCaseRepository(db).byId(id);
    expect(kase!.lane).toBe("STOPPED");
    expect(agentCalled).toBe(false);

    const events = await new PostgresEventLog(db).forCase(id);
    expect(events.find((e) => e.type === "CASE_STOPPED")).toMatchObject({
      payload: { reason: "user_requested", note: "testing" },
    });
  });

  it("a stop set before step() short-circuits before the agent or the gateway ever run", async () => {
    const id = await seed();
    let agentCalled = false;
    const gateway = new FakeGateway();
    const stopRegistry = new InMemoryStopStore();
    stopRegistry.stopCase(id, { reason: "user_requested" });
    const pipeline = new RecoveryPipeline(
      baseDeps(
        stopRegistry,
        async () => {
          agentCalled = true;
          return proposal;
        },
        gateway,
      ),
    );

    const outcome = await pipeline.step(id);

    expect(outcome).toEqual({ kind: "resolved", lane: "STOPPED" });
    expect(agentCalled).toBe(false);
    expect(gateway.orders).toBe(0);
  });

  it("a stop that arrives while the agent is running still lands before the gate or gateway", async () => {
    const id = await seed();
    const gateway = new FakeGateway();
    const stopRegistry = new InMemoryStopStore();
    // Simulates the stop request landing mid-investigation: the agent call itself is what
    // triggers it, standing in for a stop POST arriving while the real model call is in flight.
    const pipeline = new RecoveryPipeline(
      baseDeps(
        stopRegistry,
        async () => {
          stopRegistry.stopCase(id, { reason: "user_requested" });
          return proposal;
        },
        gateway,
      ),
    );

    const outcome = await pipeline.step(id);

    expect(outcome).toEqual({ kind: "resolved", lane: "STOPPED" });
    expect(gateway.orders).toBe(0);

    const kase = await new PostgresCaseRepository(db).byId(id);
    expect(kase!.lane).toBe("STOPPED");
  });

  it("the global brake blocks a case seeded after it was hit, and resumeAll lifts it", async () => {
    const id = await seed();
    const stopRegistry = new InMemoryStopStore();
    const pipeline = new RecoveryPipeline(baseDeps(stopRegistry, async () => proposal));

    stopRegistry.stopAll({ reason: "user_requested", note: "emergency" });

    // Global takes precedence over any per-case state, so this blocks a case that did not exist
    // when the brake was hit, not just ones requestStopAll happened to see at that instant.
    const blocked = await pipeline.step(id);
    expect(blocked).toEqual({ kind: "resolved", lane: "STOPPED" });

    pipeline.resumeAll();

    const id2 = await seed();
    let agentCalled = false;
    const pipelineAfterResume = new RecoveryPipeline(
      baseDeps(stopRegistry, async () => {
        agentCalled = true;
        return { ...proposal, action: { kind: "ESCALATE", reason: "test" } };
      }),
    );
    const outcome = await pipelineAfterResume.step(id2);
    expect(agentCalled).toBe(true);
    expect(outcome).toEqual({ kind: "resolved", lane: "ESCALATED" });
  });
});

// requestStopAll's immediate sweep calls cases.listLive() and resolves every idle/parked case it
// finds — against the real dev database that would also catch the room's own seeded demo cases
// (cust_live_demo, cust_over_cap sit in INCOMING on purpose). Verified against an in-memory fake
// instead, which can assert the sweep's scope precisely without touching shared data.
describe("RecoveryPipeline.requestStopAll", () => {
  type FakeRow = { id: string; lane: string };

  function fakeCases(rows: FakeRow[]) {
    return {
      byId: async (id: string) => {
        const row = rows.find((r) => r.id === id);
        return row ? ({ id: row.id, lane: row.lane } as never) : null;
      },
      listLive: async () => rows.map((r) => ({ id: r.id, lane: r.lane }) as never),
      moveLane: async (id: string, from: string, to: string) => {
        const row = rows.find((r) => r.id === id);
        if (!row || row.lane !== from) return false;
        row.lane = to;
        return true;
      },
    } as never;
  }

  it("resolves every idle/parked live case, skips in-flight and already-terminal ones", async () => {
    const rows: FakeRow[] = [
      { id: "incoming-1", lane: "INCOMING" },
      { id: "retry-1", lane: "RETRY_SCHEDULED" },
      { id: "diagnosing-1", lane: "DIAGNOSING" },
      { id: "recovered-1", lane: "RECOVERED" },
    ];
    const appended: unknown[] = [];
    const pipeline = new RecoveryPipeline({
      cases: fakeCases(rows),
      attempts: {} as never,
      events: { append: async (e: unknown) => void appended.push(e), forCase: async () => [] } as never,
      gateway: new FakeGateway(),
      outcomeResolver: new ScriptedResolver([]),
      notifier: { send: async () => ({ messageRef: "stub", delivered: false }) },
      clock: { now: () => new Date() },
      runAgent: async () => proposal,
    });

    const { stoppedNow } = await pipeline.requestStopAll({ reason: "user_requested" });

    expect(stoppedNow).toBe(2);
    expect(rows.find((r) => r.id === "incoming-1")!.lane).toBe("STOPPED");
    expect(rows.find((r) => r.id === "retry-1")!.lane).toBe("STOPPED");
    expect(rows.find((r) => r.id === "diagnosing-1")!.lane).toBe("DIAGNOSING");
    expect(rows.find((r) => r.id === "recovered-1")!.lane).toBe("RECOVERED");
    expect(appended.filter((e) => (e as { type: string }).type === "CASE_STOPPED")).toHaveLength(2);
  });
});
