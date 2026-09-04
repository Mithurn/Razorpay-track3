import { describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../src/api/routes.js";
import type { Lane } from "../src/domain/case.js";

// Opening a stream must say whether a worker is actually holding the case. Without it the client
// cannot distinguish a live run from a settled case it has merely opened, and every historical
// case renders as an agent stuck mid-investigation.
//
// An SSE response never ends, so these read the opening frames off a real socket and abort,
// rather than waiting for a completion that does not come.

type StreamFrame = { type: string; lane?: string; active?: boolean };

async function openingFrames(lane: Lane | null): Promise<StreamFrame[]> {
  const app: FastifyInstance = Fastify();
  await registerRoutes(app, {
    gateway: { getPaymentLink: async () => null },
    cases: {
      byId: async () => (lane === null ? null : { id: "c1", lane }),
    } as never,
    attempts: {} as never,
    events: {} as never,
    runs: {} as never,
    queue: {} as never,
    webhookHandler: {} as never,
    bus: { subscribe: () => () => undefined } as never,
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
    razorpayWebhookSecret: "whsec_stream_test",
    demoAccessToken: "test-token",
  });

  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const controller = new AbortController();
  try {
    const res = await fetch(`${address}/cases/c1/stream`, {
      signal: controller.signal,
    headers: { authorization: "Bearer test-token" },
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // `status` is written after a repository read, so it lands in a later chunk than `open`.
    // Drain until the socket goes quiet: a case that does not exist sends no status at all, so
    // waiting for one specifically would hang on the keep-alive.
    const idle = Symbol("idle");
    for (;;) {
      const next = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r(idle), 250)),
      ]);
      if (next === idle) break;
      const { done, value } = next as { done: boolean; value?: Uint8Array };
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer
      .split("\n\n")
      .map((c) => c.replace(/^data: /, ""))
      .filter(Boolean)
      .flatMap((j) => {
        try {
          return [JSON.parse(j) as StreamFrame];
        } catch {
          return [];
        }
      });
  } finally {
    controller.abort();
    await app.close();
  }
}

const statusOf = (frames: StreamFrame[]) =>
  frames.find((e) => e.type === "status");

describe("case stream reports whether a run is in flight", () => {
  for (const lane of ["DIAGNOSING", "DECIDING", "ATTEMPTING"] as const) {
    it(`reports active for a case in ${lane}`, async () => {
      expect(statusOf(await openingFrames(lane))).toEqual({
        type: "status",
        lane,
        active: true,
      });
    });
  }

  for (const lane of [
    "INCOMING",
    "RETRY_SCHEDULED",
    "RECOVERED",
    "ESCALATED",
    "WRITTEN_OFF",
  ] as const) {
    it(`reports inactive for a case parked in ${lane}`, async () => {
      expect(statusOf(await openingFrames(lane))).toEqual({
        type: "status",
        lane,
        active: false,
      });
    });
  }

  it("omits the status for a case that does not exist", async () => {
    const frames = await openingFrames(null);
    expect(statusOf(frames)).toBeUndefined();
    expect(frames.find((e) => e.type === "open")).toBeDefined();
  });
});
