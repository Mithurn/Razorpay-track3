import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { LanePublishingCaseRepository } from "../src/persistence/lane-publishing-case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { PublishingEventLog } from "../src/persistence/publishing-event-log.js";
import { CaseEventBus } from "../src/api/event-bus.js";
import { registerRoutes } from "../src/api/routes.js";
import { RecoveryPipeline, type PipelineDeps } from "../src/worker/pipeline.js";
import { makeProcessor } from "../src/worker/recovery-worker.js";
import { StopRegistry } from "../src/worker/stop-registry.js";
import type { AgentProposal } from "../src/domain/recovery-action.js";
import type { AgentEvents } from "../src/agent/recovery-agent.js";
import type { OutcomeResolver, OutcomeVerdict } from "../src/domain/ports.js";
import type { GatewayOrder, GatewayPayment, GatewayPaymentLink, PaymentGateway } from "../src/domain/gateway.js";
import type { RecoveryJob } from "../src/worker/queue.js";
import { isRiskHold } from "../src/domain/case.js";
import { LoggingNotifier } from "../src/execution/notifier.js";

// The other integration tests each prove one seam works against real Postgres. This proves the
// seams are actually wired together the way main.ts wires them: a full turn through the same
// RecoveryPipeline + makeProcessor + PublishingEventLog + CaseEventBus + registerRoutes stack,
// read back from the real database and off real SSE sockets — not mocked at any of those
// boundaries. The agent itself is scripted (deterministic, no external API call) but drives the
// exact same AgentEvents callbacks recovery-agent.ts does, so the tool-call/result plumbing this
// session added is exercised for real. The real model path was separately verified live against
// a running dev server earlier this session (captured in the session transcript, not repeated
// here to keep this deterministic and fast).

const adminUrl = process.env.ADMIN_DATABASE_URL;

class FakeGateway implements PaymentGateway {
  orders = 0;
  async createOrder(i: { amountPaise: number }): Promise<GatewayOrder> {
    this.orders++;
    return { id: `order_lc_${this.orders}`, amountPaise: i.amountPaise };
  }
  async createPaymentLink(i: { amountPaise: number }): Promise<GatewayPaymentLink> {
    return { id: "plink_lc", url: "x", amountPaise: i.amountPaise };
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

// Stands in for runRecoveryAgent: fires the same AgentEvents sequence the real loop does
// (tool call, tool result, tool call, tool result, concluded) before returning a proposal.
function scriptedAgent(proposal: AgentProposal, onFire?: () => void) {
  return async (_deps: unknown, events: AgentEvents): Promise<AgentProposal> => {
    onFire?.();
    await events.onToolCall?.({ name: "get_customer_payment_history", callId: "call_lc_1", args: {} });
    await events.onToolResult?.({
      name: "get_customer_payment_history",
      callId: "call_lc_1",
      source: "local",
      raw: { totalPayments: 4 },
      ms: 3,
    });
    await events.onToolCall?.({ name: "check_bank_downtime", callId: "call_lc_2", args: {} });
    await events.onToolResult?.({
      name: "check_bank_downtime",
      callId: "call_lc_2",
      source: "razorpay-live",
      raw: { matched: false },
      ms: 5,
    });
    events.onConcluded?.(proposal);
    return proposal;
  };
}

type Frame = Record<string, unknown>;

async function readSse(url: string, onOpen: (drain: () => Promise<Frame[]>) => Promise<void>) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = () => {
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    return parts
      .map((c) => c.replace(/^data: /, ""))
      .filter(Boolean)
      .flatMap((j) => {
        try {
          return [JSON.parse(j) as Frame];
        } catch {
          return [];
        }
      });
  };
  const drain = async (): Promise<Frame[]> => {
    const idle = Symbol("idle");
    const collected: Frame[] = [];
    for (;;) {
      const next = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(idle), 300))]);
      if (next === idle) break;
      const { done, value } = next as { done: boolean; value?: Uint8Array };
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      collected.push(...parse());
    }
    return collected;
  };
  try {
    await onOpen(drain);
  } finally {
    controller.abort();
  }
}

describe.runIf(adminUrl)("full backend lifecycle: investigate -> tools -> diagnose -> propose -> gate -> execute -> outcome", () => {
  let db: Db;
  const seededIds: string[] = [];

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

  async function seed(amountPaise = 149900): Promise<string> {
    const id = randomUUID();
    seededIds.push(id);
    await new PostgresCaseRepository(db).create({
      id,
      runId: null,
      merchantRef: "m",
      customerRef: "c",
      originalPaymentId: null,
      amountPaise,
      currency: "INR",
      failureCode: "BAD_REQUEST_ERROR",
      failureReason: "card_declined",
      failedAt: new Date().toISOString(),
      method: "card",
      instrument: { issuer: "BKID" },
      customerHistory: [],
    });
    return id;
  }

  // Wires the same stack main.ts wires: PublishingEventLog fans every append to both the
  // per-case SSE channel and the room channel; LanePublishingCaseRepository turns every lane
  // move into a durable, relayed CASE_LANE_CHANGED.
  function buildStack(runAgent: PipelineDeps["runAgent"], opts: { gateway?: FakeGateway; stopRegistry?: StopRegistry } = {}) {
    const bus = new CaseEventBus();
    const eventLog = new PublishingEventLog(new PostgresEventLog(db), bus);
    const cases = new LanePublishingCaseRepository(new PostgresCaseRepository(db), eventLog);
    const attempts = new PostgresAttemptRepository(db);
    const gateway = opts.gateway ?? new FakeGateway();
    const pipeline = new RecoveryPipeline({
      cases,
      attempts,
      events: eventLog,
      gateway,
      outcomeResolver: new ScriptedResolver([{ kind: "recovered", capturedPaise: 149900, paymentId: "pay_lc_1" }]),
      notifier: new LoggingNotifier(eventLog),
      clock: { now: () => new Date() },
      riskHoldForCase: isRiskHold,
      runAgent,
      stopRegistry: opts.stopRegistry,
    });
    const noopQueue = { add: async () => undefined } as unknown as import("bullmq").Queue<RecoveryJob>;
    const process = makeProcessor(pipeline, noopQueue, bus, eventLog);
    return { bus, cases, eventLog, gateway, pipeline, process };
  }

  async function buildApp(bus: CaseEventBus, cases: LanePublishingCaseRepository, pipeline: RecoveryPipeline): Promise<{ app: FastifyInstance; address: string }> {
    const app = Fastify();
    await registerRoutes(app, {
      cases,
      attempts: {} as never,
      events: {} as never,
      runs: {} as never,
      queue: {} as never,
      webhookHandler: {} as never,
      bus,
      pipeline,
      modelHealth: async () => ({ model: "test", reachable: true }),
      verifyAppendOnly: async () => ({ enforced: true, role: "recovery_app" }),
      runtimeInfo: {
        model: "test",
        deadlineMs: 90_000,
        stepBudget: 6,
        limits: { maxAttempts: 4, maxExposurePaise: 500_000, cooldownHours: 6, minConfidence: 0.6, contactCooldownHours: 24 },
      },
      razorpayWebhookSecret: "whsec_full_lifecycle_test",
      demoAccessToken: undefined,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    return { app, address };
  }

  it("recovers a case and every stage reaches Postgres, the room stream, and metrics", async () => {
    const id = await seed();
    let agentFired = false;
    const { bus, cases, eventLog, gateway, pipeline, process } = buildStack(
      scriptedAgent(
        {
          action: { kind: "RETRY_NOW" },
          diagnosisRootCause: "soft_decline",
          confidence: 0.9,
          reasoning: "a retry should clear this",
          toolCalls: 2,
          degraded: false,
        },
        () => (agentFired = true),
      ),
    );
    const { app, address } = await buildApp(bus, cases, pipeline);
    const before = await cases.metrics();

    try {
      let caseFrames: Frame[] = [];
      let roomFrames: Frame[] = [];
      await readSse(`${address}/cases/${id}/stream`, async (drainCase) => {
        await readSse(`${address}/stream`, async (drainRoom) => {
          // Both streams are open and subscribed before anything runs.
          await process({ caseId: id });
          caseFrames = await drainCase();
          roomFrames = await drainRoom();
        });
      });

      expect(agentFired).toBe(true);
      expect(gateway.orders).toBe(1);

      const recorded = await new PostgresEventLog(db).forCase(id);
      const types = recorded.map((e) => e.type);
      expect(types).toEqual([
        "CASE_LANE_CHANGED", // INCOMING -> DIAGNOSING
        "INVESTIGATION_STARTED",
        "TOOL_CALLED",
        "TOOL_RESULT",
        "TOOL_CALLED",
        "TOOL_RESULT",
        "AGENT_PROPOSED",
        "CASE_LANE_CHANGED", // DIAGNOSING -> DECIDING
        "GATE_APPLIED",
        "CASE_LANE_CHANGED", // DECIDING -> ATTEMPTING
        "ATTEMPT_STARTED",
        "ATTEMPT_OUTCOME", // the executor settles and records the outcome first
        "CASE_LANE_CHANGED", // only then does resolve() move ATTEMPTING -> RECOVERED
        "CASE_RESOLVED",
      ]);

      // Every TOOL_CALLED commits before its own TOOL_RESULT — the ordering fix from earlier
      // this session, re-checked here at the full-stack level, not just the unit level.
      const toolCalledIdx = recorded.findIndex((e) => e.type === "TOOL_CALLED");
      const toolResultIdx = recorded.findIndex((e) => e.type === "TOOL_RESULT");
      expect(toolCalledIdx).toBeLessThan(toolResultIdx);

      const gate = recorded.find((e) => e.type === "GATE_APPLIED")!;
      expect(gate.payload).toMatchObject({ outcome: "allow", rule: null, detail: null, activity: "gate" });

      const kase = await new PostgresCaseRepository(db).byId(id);
      expect(kase!.lane).toBe("RECOVERED");
      expect(kase!.recoveredPaise).toBe(149900);

      // Room stream carries every one of those events, tagged with the case they belong to.
      const roomTypes = roomFrames.filter((f) => f.type === "audit").map((f) => f.eventType);
      expect(roomTypes).toEqual(types);
      expect(roomFrames.every((f) => f.type !== "audit" || f.caseId === id)).toBe(true);

      // Per-case stream: opens honestly (not active, since nothing was mid-flight when it
      // subscribed) and carries the same durable events as `audit`, plus the live tool signals.
      expect(caseFrames[0]).toEqual({ type: "open", caseId: id });
      expect(caseFrames.find((f) => f.type === "tool_result" && f.name === "check_bank_downtime")).toBeDefined();
      expect(caseFrames.filter((f) => f.type === "audit").map((f) => f.eventType)).toEqual(types);

      // Metrics reflect the real, just-written state — not a cached or estimated number.
      const after = await cases.metrics();
      expect(after.recoveredPaise - before.recoveredPaise).toBe(149900);
      expect((after.byLane.RECOVERED ?? 0) - (before.byLane.RECOVERED ?? 0)).toBe(1);
    } finally {
      await app.close();
    }
  }, 15000);

  it("a guardrail clamp is a structured event end to end, and never calls the gateway", async () => {
    const id = await seed(600_000); // over the 500_000 exposure cap configured for this test
    const { bus, cases, gateway, pipeline, process } = buildStack(
      scriptedAgent({
        action: { kind: "RETRY_NOW" },
        diagnosisRootCause: "soft_decline",
        confidence: 0.9,
        reasoning: "a retry should clear this",
        toolCalls: 2,
        degraded: false,
      }),
    );
    const { app, address } = await buildApp(bus, cases, pipeline);

    try {
      let roomFrames: Frame[] = [];
      await readSse(`${address}/stream`, async (drainRoom) => {
        await process({ caseId: id });
        roomFrames = await drainRoom();
      });

      expect(gateway.orders).toBe(0);

      const recorded = await new PostgresEventLog(db).forCase(id);
      const gate = recorded.find((e) => e.type === "GATE_APPLIED")!;
      expect(gate.payload).toMatchObject({
        outcome: "clamp",
        rule: "exposure_cap",
        proposed: "RETRY_NOW",
        applied: "ESCALATE",
        activity: "gate",
      });
      expect(typeof (gate.payload as { detail: unknown }).detail).toBe("string");

      const resolved = recorded.find((e) => e.type === "CASE_RESOLVED")!;
      expect(resolved.payload).toMatchObject({ lane: "ESCALATED" });

      const roomGate = roomFrames.find((f) => f.type === "audit" && f.eventType === "GATE_APPLIED")!;
      expect((roomGate.payload as { rule: string }).rule).toBe("exposure_cap");

      const kase = await new PostgresCaseRepository(db).byId(id);
      expect(kase!.lane).toBe("ESCALATED");
    } finally {
      await app.close();
    }
  }, 15000);

  it("stop prevents the gateway from ever being called, resolves to STOPPED, and it's a structured event too", async () => {
    const id = await seed();
    const stopRegistry = new StopRegistry();
    const { bus, cases, gateway, pipeline, process } = buildStack(
      scriptedAgent(
        {
          action: { kind: "RETRY_NOW" },
          diagnosisRootCause: "soft_decline",
          confidence: 0.9,
          reasoning: "a retry should clear this",
          toolCalls: 2,
          degraded: false,
        },
        // Simulates a stop request landing while the agent call is in flight.
        () => stopRegistry.stopCase(id, { reason: "user_requested", note: "verification" }),
      ),
      { stopRegistry },
    );
    const { app, address } = await buildApp(bus, cases, pipeline);

    try {
      let roomFrames: Frame[] = [];
      await readSse(`${address}/stream`, async (drainRoom) => {
        await process({ caseId: id });
        roomFrames = await drainRoom();
      });

      expect(gateway.orders).toBe(0);

      const recorded = await new PostgresEventLog(db).forCase(id);
      expect(recorded.map((e) => e.type)).not.toContain("ATTEMPT_STARTED");
      expect(recorded.map((e) => e.type)).not.toContain("GATE_APPLIED");
      const stopped = recorded.find((e) => e.type === "CASE_STOPPED")!;
      expect(stopped.payload).toMatchObject({ reason: "user_requested", note: "verification", activity: "outcome" });

      const roomStopped = roomFrames.find((f) => f.type === "audit" && f.eventType === "CASE_STOPPED");
      expect(roomStopped).toMatchObject({ caseId: id });

      const kase = await new PostgresCaseRepository(db).byId(id);
      expect(kase!.lane).toBe("STOPPED");

      const metrics = await cases.metrics();
      expect(metrics.byLane.STOPPED ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  }, 15000);
});
