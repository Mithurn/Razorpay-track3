import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../src/api/routes.js";
import { CaseEventBus } from "../src/api/event-bus.js";

// The room stream is the one channel meant to carry every durable event across every case. An
// SSE response never ends, so this reads frames off a real socket and aborts rather than waiting
// for a completion that never comes — same approach as the per-case stream test.

type Frame = Record<string, unknown>;

async function withRoomStream(
  run: (opts: {
    readFrame: (ms?: number) => Promise<Frame | null>;
    bus: CaseEventBus;
  }) => Promise<void>,
): Promise<void> {
  const bus = new CaseEventBus();
  const app: FastifyInstance = Fastify();
  await registerRoutes(app, {
    gateway: { getPaymentLink: async () => null },
    cases: {
      byId: async () => null,
      metrics: async () => ({
        recoveredPaise: 62_459_00,
        exposurePaise: 1_499_00,
        liveCases: 62,
        byLane: { RECOVERED: 41, ESCALATED: 18, WRITTEN_OFF: 2, INCOMING: 1 },
      }),
    } as never,
    attempts: {} as never,
    events: {} as never,
    runs: {} as never,
    queue: {} as never,
    webhookHandler: {} as never,
    bus,
    pipeline: {
      requestStop: async () => undefined,
      requestStopAll: async () => ({ stoppedNow: 0 }),
      resumeAll: () => undefined,
      isBraked: () => false,
    },
    modelHealth: async () => ({ model: "test", reachable: true }),
    verifyAppendOnly: async () => ({ enforced: true, role: "recovery_app" }),
    runtimeInfo: {
      model: "test",
      deadlineMs: 90_000,
      stepBudget: 6,
      limits: {
        maxAttempts: 4,
        maxExposurePaise: 500000,
        cooldownHours: 6,
        minConfidence: 0.6,
        contactCooldownHours: 24,
      },
      razorpayKeyId: "rzp_test_stub",
    },
    razorpayWebhookSecret: "whsec_room_stream_test",
    demoAccessToken: "test-token",
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  try {
    const res = await fetch(`${address}/stream`, {
      signal: controller.signal,
      headers: { authorization: "Bearer test-token" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const queue: Frame[] = [];

    const drain = () => {
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const chunk of parts) {
        const data = chunk.replace(/^data: /, "");
        if (!data) continue;
        try {
          queue.push(JSON.parse(data) as Frame);
        } catch {
          // keep-alive comment lines are not JSON
        }
      }
    };

    // Pulls the next already-parsed frame, reading more off the socket (bounded by `ms`) only
    // when the queue is empty — so a frame published mid-test is actually waited for, not just
    // whatever had arrived by some earlier, unrelated read.
    const readFrame = async (ms = 500): Promise<Frame | null> => {
      const idle = Symbol("idle");
      while (queue.length === 0) {
        const next = await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r(idle), ms)),
        ]);
        if (next === idle) return null;
        const { done, value } = next as { done: boolean; value?: Uint8Array };
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        drain();
      }
      return queue.shift()!;
    };

    await run({ readFrame, bus });
  } finally {
    controller.abort();
    await app.close();
  }
}

describe("room-wide stream", () => {
  it("opens with the current metrics snapshot before any live event", async () => {
    await withRoomStream(async ({ readFrame }) => {
      expect(await readFrame()).toEqual({ type: "open" });
      expect(await readFrame()).toEqual({
        type: "metrics",
        recoveredPaise: 62_459_00,
        exposurePaise: 1_499_00,
        liveCases: 62,
        byLane: { RECOVERED: 41, ESCALATED: 18, WRITTEN_OFF: 2, INCOMING: 1 },
        braked: false,
      });
    });
  });

  it("relays a durable event published for any case, not just one being watched", async () => {
    await withRoomStream(async ({ readFrame, bus }) => {
      await readFrame(); // open
      await readFrame(); // metrics

      bus.publishRoom({
        type: "audit",
        caseId: "case-elsewhere",
        eventType: "CASE_LANE_CHANGED",
        payload: { from: "INCOMING", to: "DIAGNOSING" },
        at: "2026-09-03T12:00:00.000Z",
      });

      expect(await readFrame()).toEqual({
        type: "audit",
        caseId: "case-elsewhere",
        eventType: "CASE_LANE_CHANGED",
        payload: { from: "INCOMING", to: "DIAGNOSING" },
        at: "2026-09-03T12:00:00.000Z",
      });
    });
  });
});
