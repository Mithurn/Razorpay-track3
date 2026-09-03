import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes } from "../src/api/routes.js";

// The auth hook runs before any DB lookup, so these routes can be exercised against a fake case
// id with no database at all — an unauthorized request must never reach the handler.

async function buildApp(demoAccessToken: string | undefined): Promise<FastifyInstance> {
  const app = Fastify();
  await registerRoutes(app, {
    cases: { byId: async () => null } as never,
    attempts: {} as never,
    events: {} as never,
    runs: {} as never,
    queue: { add: async () => undefined } as never,
    webhookHandler: {} as never,
    bus: { subscribe: () => () => undefined } as never,
    modelHealth: async () => ({ model: "test", reachable: true }),
    verifyAppendOnly: async () => ({ enforced: true, role: "recovery_app" }),
    runtimeInfo: {
      model: "test",
      deadlineMs: 90_000,
      stepBudget: 6,
      limits: { maxAttempts: 4, maxExposurePaise: 500000, cooldownHours: 6, minConfidence: 0.6 },
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

  for (const route of ["/cases/x/recover", "/cases/x/decision", "/cases/x/simulate-capture"]) {
    it(`rejects ${route} with no Authorization header`, async () => {
      app = await buildApp("real-token");
      const res = await app.inject({ method: "POST", url: route });
      expect(res.statusCode).toBe(401);
    });

    it(`rejects ${route} with the wrong token`, async () => {
      app = await buildApp("real-token");
      const res = await app.inject({
        method: "POST",
        url: route,
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.statusCode).toBe(401);
    });

    it(`rejects ${route} whatever the header when no token is configured`, async () => {
      app = await buildApp(undefined);
      const res = await app.inject({
        method: "POST",
        url: route,
        headers: { authorization: "Bearer anything" },
      });
      expect(res.statusCode).toBe(401);
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
