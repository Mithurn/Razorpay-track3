import { describe, expect, it, vi } from "vitest";
import { startReconcileSweep } from "../src/worker/reconcile-sweep.js";
import type { AttemptRepository, CaseRepository } from "../src/domain/ports.js";
import type { Attempt } from "../src/domain/attempt.js";
import type { RecoveryCase } from "../src/domain/case.js";

const attempt = (over: Partial<Attempt>): Attempt => ({
  id: "a1",
  caseId: "c1",
  attemptNo: 1,
  rootCause: "technical",
  action: "RETRY_NOW",
  reasoning: null,
  idempotencyKey: "c1:1",
  razorpayRef: "order_1",
  settledPaymentId: null,
  status: "AWAITING_RECONCILIATION",
  detail: null,
  clamped: false,
  clampReason: null,
  recoveredPaise: 0,
  createdAt: new Date().toISOString(),
  ...over,
});

const kase = (over: Partial<RecoveryCase>): RecoveryCase => ({
  id: "c1",
  runId: null,
  merchantRef: "m",
  customerRef: "c",
  originalPaymentId: null,
  amountPaise: 1000,
  currency: "INR",
  failureCode: "X",
  failureReason: "card_declined",
  failedAt: new Date().toISOString(),
  method: "card",
  instrument: null,
  customerHistory: [],
  lane: "ATTEMPTING",
  recoveredPaise: 0,
  ...over,
});

describe("reconcile sweep", () => {
  it("re-queues each case that owns a parked attempt, once", async () => {
    const attempts = { listUnsettled: async () => [attempt({}), attempt({ id: "a2", attemptNo: 2 })] } as unknown as AttemptRepository;
    const cases = {
      byId: async () => kase({}),
      listStaleInLane: async () => [],
    } as unknown as CaseRepository;
    const add = vi.fn(async () => undefined);

    const { stop } = startReconcileSweep(attempts, cases, { add } as never, 10);
    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(add).toHaveBeenCalled();
    const caseIds = add.mock.calls.map((c) => (c as unknown[])[1] as { caseId: string }).map((d) => d.caseId);
    expect([...new Set(caseIds)]).toEqual(["c1"]);
  });

  it("skips a case that already reached a terminal lane", async () => {
    const attempts = { listUnsettled: async () => [attempt({})] } as unknown as AttemptRepository;
    const cases = {
      byId: async () => kase({ lane: "RECOVERED" }),
      listStaleInLane: async () => [],
    } as unknown as CaseRepository;
    const add = vi.fn(async () => undefined);

    const { stop } = startReconcileSweep(attempts, cases, { add } as never, 10);
    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(add).not.toHaveBeenCalled();
  });

  it("force-reclaims a case orphaned in DIAGNOSING with no live job behind it", async () => {
    const attempts = { listUnsettled: async () => [] } as unknown as AttemptRepository;
    const cases = {
      byId: async () => kase({ lane: "DIAGNOSING" }),
      listStaleInLane: async () => [kase({ lane: "DIAGNOSING" })],
    } as unknown as CaseRepository;
    const add = vi.fn(async () => undefined);

    const { stop } = startReconcileSweep(attempts, cases, { add } as never, 10);
    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(add).toHaveBeenCalled();
    const [, data, opts] = add.mock.calls[0] as unknown[];
    expect((data as { caseId: string }).caseId).toBe("c1");
    expect((data as { reclaim?: boolean }).reclaim).toBe(true);
    expect((opts as { jobId: string }).jobId).toBe("c1");
  });
});
