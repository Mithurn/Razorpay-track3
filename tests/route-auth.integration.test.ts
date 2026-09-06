import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../src/api/routes.js";

// The auth hook runs before any DB lookup, so these routes can be exercised against a fake case
// id with no database at all — an unauthorized request must never reach the handler.

async function buildApp(
  demoAccessToken: string | undefined,
): Promise<FastifyInstance> {
  const app = Fastify();
  await registerRoutes(app, {
    gateway: { getPaymentLink: async () => null },
    cases: { byId: async () => null } as never,
    attempts: {} as never,
    events: {} as never,
    runs: {} as never,
    queue: { add: async () => undefined } as never,
    webhookHandler: {} as never,
    bus: { subscribe: () => () => undefined } as never,
    pipeline: {
      requestStop: async () => undefined,
      requestStopAll: async () => ({ stoppedNow: 0 }),
      resumeAll: async () => undefined,
      isBraked: async () => false,
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
    razorpayWebhookSecret: "whsec_auth_test",
    demoAccessToken,
  });
  return app;
}

describe("mutating case routes require the demo access token", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  for (const [method, route] of [
    ["POST", "/cases/x/recover"],
    ["POST", "/cases/x/decision"],
    ["POST", "/cases/x/simulate-capture"],
    ["POST", "/cases/x/stop"],
    ["POST", "/stop"],
    ["POST", "/resume"],
  ] as const) {
    it(`rejects ${method} ${route} with no Authorization header`, async () => {
      app = await buildApp("real-token");
      const res = await app.inject({ method, url: route });
      expect(res.statusCode).toBe(401);
    });

    it(`rejects ${method} ${route} with the wrong token`, async () => {
      app = await buildApp("real-token");
      const res = await app.inject({
        method,
        url: route,
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.statusCode).toBe(401);
    });

    it(`rejects ${method} ${route} whatever the header when no token is configured`, async () => {
      app = await buildApp(undefined);
      const res = await app.inject({
        method,
        url: route,
        headers: { authorization: "Bearer anything" },
      });
      expect(res.statusCode).toBe(401);
    });
  }

  // List routes carry customerRef PII — gated by a soft auth that only activates when a token is
  // configured. Open-demo mode (no token) keeps them accessible so reviewers can run without setup.
  for (const route of ["/cases", "/queue"] as const) {
    it(`rejects GET ${route} with no Authorization header when a token is configured`, async () => {
      app = await buildApp("real-token");
      const res = await app.inject({ method: "GET", url: route });
      expect(res.statusCode).toBe(401);
    });

    it(`rejects GET ${route} with the wrong token when a token is configured`, async () => {
      app = await buildApp("real-token");
      const res = await app.inject({
        method: "GET",
        url: route,
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.statusCode).toBe(401);
    });

    it(`serves GET ${route} with no token configured (open-demo mode)`, async () => {
      app = await buildApp(undefined);
      const res = await app.inject({ method: "GET", url: route });
      expect(res.statusCode).not.toBe(401);
    });
  }

  it("passes the auth gate with the correct bearer token, and reaches the handler", async () => {
    app = await buildApp("real-token");
    const res = await app.inject({
      method: "POST",
      url: "/cases/x/recover",
      headers: { authorization: "Bearer real-token" },
    });
    // Auth passed; the fake case repo returns null past the gate, so the route's own 404 fires —
    // proof the request reached the handler rather than being rejected by the hook.
    expect(res.statusCode).toBe(404);
  });

  it("leaves the Razorpay webhook route ungated by the bearer token", async () => {
    app = await buildApp("real-token");
    const res = await app.inject({ method: "POST", url: "/webhooks/razorpay" });
    // No auth header at all; a 401 here would mean the hook leaked onto the wrong route. It
    // fails for a different, expected reason (missing HMAC signature headers), not auth.
    expect(res.statusCode).toBe(400);
  });
});

describe("read and stream routes stay open on purpose", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("audit/verify requires the demo access token", async () => {
    app = await buildApp("real-token");
    const res = await app.inject({ method: "GET", url: "/cases/x/audit/verify" });
    expect(res.statusCode).toBe(401);
  });

  it("audit/verify passes with the correct token", async () => {
    app = await buildApp("real-token");
    const res = await app.inject({
      method: "GET",
      url: "/cases/x/audit/verify",
      headers: { authorization: "Bearer real-token" },
    });
    expect(res.statusCode).toBe(200);
  });

  // /stream and /cases/:id/stream never resolve their HTTP response (SSE keeps the connection
  // open), so they aren't exercised here with inject() — stream-route.integration.test.ts and
  // room-stream.integration.test.ts cover them against a real listening server instead.
  for (const route of ["/cases/x", "/events?caseId=00000000-0000-4000-8000-000000000000"]) {
    it(`serves ${route} with no Authorization header, even when a token is configured`, async () => {
      app = await buildApp("real-token");
      const res = await app.inject({ method: "GET", url: route });
      expect(res.statusCode).not.toBe(401);
    });
  }
});
