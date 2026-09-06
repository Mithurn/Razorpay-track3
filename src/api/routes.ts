import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Queue } from "bullmq";
import type { AttemptRepository, CaseRepository, EventLog } from "../domain/ports.js";
import { IN_FLIGHT_LANES } from "../domain/case.js";
import type { RunRepository } from "../persistence/run-repository.js";
import type { WebhookHandler } from "../execution/webhook-handler.js";
import type { CaseEventBus } from "./event-bus.js";
import type { RecoveryJob } from "../worker/queue.js";
import { enqueueRecovery } from "../worker/queue.js";
import type { AuditVerifyResult } from "../persistence/audit-verify.js";
import type { SafetyLimits } from "../safety/safety-gate.js";
import type { StopRequest } from "../worker/stop-registry.js";
import type { PaymentGateway } from "../domain/gateway.js";
import { openSse } from "./sse.js";
import { directedAction, SHARED_TOKEN_APPROVER } from "../worker/human-directive.js";

export type RuntimeInfo = {
  model: string;
  deadlineMs: number;
  stepBudget: number;
  limits: SafetyLimits;
  razorpayKeyId: string;
};

export type PayInfo =
  | { payable: false }
  | { payable: true; kind: "order"; orderId: string; amountPaise: number; currency: string }
  | { payable: true; kind: "payment_link"; url: string; amountPaise: number };

export type RouteDeps = {
  cases: CaseRepository;
  attempts: AttemptRepository;
  events: EventLog;
  gateway: Pick<PaymentGateway, "getPaymentLink">;
  runs: RunRepository;
  queue: Queue<RecoveryJob>;
  webhookHandler: WebhookHandler;
  bus: CaseEventBus;
  pipeline: {
    requestStop(caseId: string, request: StopRequest): Promise<void>;
    requestStopAll(request: StopRequest): Promise<{ stoppedNow: number }>;
    resumeAll(): void;
    isBraked(): boolean;
  };
  modelHealth: () => Promise<{ model: string; reachable: boolean; detail?: string }>;
  verifyAppendOnly: () => Promise<AuditVerifyResult>;
  runtimeInfo: RuntimeInfo;
  razorpayWebhookSecret: string;
  // Never applied to the Razorpay webhook route — that's HMAC-verified, not bearer-token gated.
  demoAccessToken: string | undefined;
};

const decisionBody = z.object({
  decision: z.enum(["approve", "redirect", "write_off"]),
  redirectTo: z.enum(["RETRY_NOW", "PAYMENT_LINK", "CUSTOMER_NUDGE"]).optional(),
  note: z.string().max(500).optional(),
});

const idParams = z.object({ id: z.string().min(1) });

function parseIdParam(req: FastifyRequest, reply: FastifyReply): string | null {
  const parsed = idParams.safeParse(req.params);
  if (!parsed.success) {
    reply.code(400).send({ error: "invalid id parameter" });
    return null;
  }
  return parsed.data.id;
}

function requireAccessToken(token: string | undefined) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const expected = Buffer.from(token ?? "");
    const given = Buffer.from(provided ?? "");
    if (!token || !provided || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const requireAuth = { onRequest: requireAccessToken(deps.demoAccessToken) };
  app.get("/cases", async () => ({ cases: await deps.cases.listLive() }));

  app.get("/queue", async () => ({ cases: await deps.cases.listByLane("ESCALATED") }));

  app.get("/model-health", async () => deps.modelHealth());

  app.get("/config", async () => deps.runtimeInfo);

  app.get("/scoreboard", async () => deps.runs.latestByArm());

  app.get("/metrics", async () => ({ ...(await deps.cases.metrics()), braked: deps.pipeline.isBraked() }));

  app.get("/cases/:id", async (req, reply) => {
    const id = parseIdParam(req, reply);
    if (id === null) return;
    const kase = await deps.cases.byId(id);
    if (!kase) return reply.code(404).send({ error: "not found" });
    const [attempts, events] = await Promise.all([deps.attempts.listByCase(id), deps.events.forCase(id)]);
    return { case: kase, attempts, events };
  });

  app.get("/cases/:id/pay", async (req, reply): Promise<PayInfo> => {
    const id = parseIdParam(req, reply);
    if (id === null) return { payable: false };
    const kase = await deps.cases.byId(id);
    if (!kase) return reply.code(404).send({ payable: false });

    const pending = await deps.attempts.payableAttempt(id);
    if (!pending?.razorpayRef) return { payable: false };

    if (pending.action === "RETRY_NOW" || pending.action === "RETRY_SCHEDULED") {
      return { payable: true, kind: "order", orderId: pending.razorpayRef, amountPaise: kase.amountPaise, currency: kase.currency };
    }
    if (pending.action === "PAYMENT_LINK") {
      const link = await deps.gateway.getPaymentLink(pending.razorpayRef);
      if (!link) return { payable: false };
      return { payable: true, kind: "payment_link", url: link.url, amountPaise: link.amountPaise };
    }
    return { payable: false };
  });

  app.get("/runs/:id", async (req, reply) => {
    const id = parseIdParam(req, reply);
    if (id === null) return;
    const run = await deps.runs.byId(id);
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });

  app.get("/runs/:id/cases", async (req, reply) => {
    const id = parseIdParam(req, reply);
    if (id === null) return;
    return { cases: await deps.cases.listByRun(id) };
  });

  app.get("/events", async (req, reply) => {
    const q = z.object({ caseId: z.string().uuid() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "caseId required" });
    return { events: await deps.events.forCase(q.data.caseId) };
  });

  app.post("/cases/:id/recover", requireAuth, async (req, reply) => {
    const id = parseIdParam(req, reply);
    if (id === null) return;
    if (!(await deps.cases.byId(id))) return reply.code(404).send({ error: "not found" });
    await enqueueRecovery(deps.queue, id, { force: true });
    return reply.code(202).send({ queued: true });
  });

  const stopBody = z.object({ note: z.string().max(500).optional() });

  // Never aborts a call already in flight to Razorpay or the model — see StopRegistry.
  app.post("/cases/:id/stop", requireAuth, async (req, reply) => {
    const id = parseIdParam(req, reply);
    if (id === null) return;
    const body = stopBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!(await deps.cases.byId(id))) return reply.code(404).send({ error: "not found" });
    await deps.pipeline.requestStop(id, { reason: "user_requested", note: body.data.note });
    return { stopped: true };
  });

  app.post("/stop", requireAuth, async (req, reply) => {
    const body = stopBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const result = await deps.pipeline.requestStopAll({ reason: "user_requested", note: body.data.note });
    return { stopped: true, ...result };
  });

  app.post("/resume", requireAuth, async () => {
    deps.pipeline.resumeAll();
    return { resumed: true };
  });

  // Proves the append-only guarantee rather than asserting it — attempts a real UPDATE.
  app.get("/cases/:id/audit/verify", requireAuth, async () => deps.verifyAppendOnly());

  app.post("/cases/:id/decision", requireAuth, async (req, reply) => {
    const id = parseIdParam(req, reply);
    if (id === null) return;
    const body = decisionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const kase = await deps.cases.byId(id);
    if (!kase) return reply.code(404).send({ error: "not found" });
    if (kase.lane !== "ESCALATED") return reply.code(409).send({ error: "case is not awaiting a decision" });

    if (body.data.decision === "write_off") {
      await deps.events.append({
        caseId: id,
        type: "CASE_RESOLVED",
        payload: { via: "human", ...body.data, activity: "outcome" },
      });
      await deps.cases.moveLane(id, "ESCALATED", "WRITTEN_OFF");
      return { applied: body.data.decision };
    }

    // Recorded before the case moves, so the directive is durable before any worker can pick it up.
    const action = directedAction(body.data);
    await deps.events.append({
      caseId: id,
      type: "HUMAN_DIRECTIVE",
      payload: {
        action,
        approver: SHARED_TOKEN_APPROVER,
        at: new Date().toISOString(),
        note: body.data.note ?? null,
        decision: body.data.decision,
        activity: "outcome",
      },
    });
    await deps.cases.moveLane(id, "ESCALATED", "RETRY_SCHEDULED");
    await enqueueRecovery(deps.queue, id, { force: true });
    return { applied: body.data.decision, action: action.kind };
  });

  app.get("/stream", async (req, reply) => {
    openSse(
      req,
      reply,
      { type: "open" },
      (send) => deps.bus.subscribeRoom(send),
      async (send) => send({ type: "metrics", ...(await deps.cases.metrics()), braked: deps.pipeline.isBraked() }),
    );
  });

  app.get("/cases/:id/stream", async (req, reply) => {
    const id = parseIdParam(req, reply);
    if (id === null) return;
    openSse(
      req,
      reply,
      { type: "open", caseId: id },
      (send) => deps.bus.subscribe(id, send),
      // Without a status frame, a finished case looks identical to one stuck mid-investigation.
      async (send) => {
        const kase = await deps.cases.byId(id);
        if (kase) send({ type: "status", lane: kase.lane, active: IN_FLIGHT_LANES.includes(kase.lane) });
      },
    );
  });

  // Demo aid: builds a real signed webhook and runs it through the same handler a live delivery hits.
  app.post("/cases/:id/simulate-capture", requireAuth, async (req, reply) => {
    const id = parseIdParam(req, reply);
    if (id === null) return;
    const kase = await deps.cases.byId(id);
    if (!kase) return reply.code(404).send({ error: "not found" });
    const attempt = (await deps.attempts.listByCase(id)).find((a) => a.status === "PENDING" && a.razorpayRef);
    if (!attempt) return reply.code(409).send({ error: "no pending attempt with a razorpay order" });

    const rawBody = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: `pay_sim_${randomUUID().slice(0, 12)}`,
            order_id: attempt.razorpayRef,
            amount: kase.amountPaise,
            status: "captured",
          },
        },
      },
    });
    const signature = createHmac("sha256", deps.razorpayWebhookSecret).update(rawBody).digest("hex");
    const result = await deps.webhookHandler.handle({ rawBody, signature, eventId: `evt_sim_${randomUUID()}` });
    return result;
  });

  app.post("/webhooks/razorpay", async (req, reply) => {
    const signature = req.headers["x-razorpay-signature"];
    const eventId = req.headers["x-razorpay-event-id"];
    if (typeof signature !== "string" || typeof eventId !== "string") {
      return reply.code(400).send({ error: "missing signature headers" });
    }
    // A re-serialized body can never verify against Razorpay's HMAC — fail loudly, not silently.
    const rawBody = (req as { rawBody?: string }).rawBody;
    if (rawBody === undefined) return reply.code(500).send({ error: "rawBody unavailable" });
    const result = await deps.webhookHandler.handle({ rawBody, signature, eventId });
    const code = result.status === "invalid_signature" ? 401 : result.status === "malformed" ? 400 : 200;
    return reply.code(code).send(result);
  });
}
