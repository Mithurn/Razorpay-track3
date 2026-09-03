import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Queue } from "bullmq";
import type { AttemptRepository, CaseRepository, EventLog } from "../domain/ports.js";
import { IN_FLIGHT_LANES } from "../domain/case.js";
import type { RecoveryAction } from "../domain/recovery-action.js";
import type { RunRepository } from "../persistence/run-repository.js";
import type { WebhookHandler } from "../execution/webhook-handler.js";
import type { CaseEventBus } from "./event-bus.js";
import type { RecoveryJob } from "../worker/queue.js";
import { enqueueRecovery } from "../worker/queue.js";
import type { AuditVerifyResult } from "../persistence/audit-verify.js";
import type { SafetyLimits } from "../safety/safety-gate.js";
import type { StopRequest } from "../worker/stop-registry.js";

export type RuntimeInfo = {
  model: string;
  deadlineMs: number;
  stepBudget: number;
  limits: SafetyLimits;
};

export type RouteDeps = {
  cases: CaseRepository;
  attempts: AttemptRepository;
  events: EventLog;
  runs: RunRepository;
  queue: Queue<RecoveryJob>;
  webhookHandler: WebhookHandler;
  bus: CaseEventBus;
  // Narrowed to just the stop surface — routes have no business touching the rest of the
  // pipeline's API.
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
  // Gates the mutating case routes. Not Razorpay's webhook route, which is HMAC-verified on its
  // own terms — a bearer-token hook must never be applied there or real deliveries would 401.
  demoAccessToken: string | undefined;
};

const decisionBody = z.object({
  decision: z.enum(["approve", "redirect", "write_off"]),
  redirectTo: z.enum(["RETRY_NOW", "PAYMENT_LINK", "CUSTOMER_NUDGE"]).optional(),
  note: z.string().max(500).optional(),
});

// The demo authenticates with one shared bearer token, so there is no per-person identity to
// record. Named plainly rather than invented: a real deployment puts the signed-in reviewer here.
const SHARED_TOKEN_APPROVER = "demo-operator (shared token)";

function directedAction(body: z.infer<typeof decisionBody>): RecoveryAction {
  const kind = body.decision === "approve" ? "RETRY_NOW" : (body.redirectTo ?? "RETRY_NOW");
  if (kind === "PAYMENT_LINK") return { kind, rail: "card" };
  if (kind === "CUSTOMER_NUDGE") return { kind, channel: "email" };
  return { kind: "RETRY_NOW" };
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

  // Room-wide totals over live cases, computed fresh from recovery_cases on every call — cheap
  // aggregate SQL, no caching layer. Not the batch scoreboard: no recovery-rate/lift claim here,
  // because there is no live control arm to compare against, only the recorded batch run.
  app.get("/metrics", async () => ({ ...(await deps.cases.metrics()), braked: deps.pipeline.isBraked() }));

  app.get("/cases/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const kase = await deps.cases.byId(id);
    if (!kase) return reply.code(404).send({ error: "not found" });
    const [attempts, events] = await Promise.all([deps.attempts.listByCase(id), deps.events.forCase(id)]);
    return { case: kase, attempts, events };
  });

  app.get("/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await deps.runs.byId(id);
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });

  app.get("/runs/:id/cases", async (req) => {
    const { id } = req.params as { id: string };
    return { cases: await deps.cases.listByRun(id) };
  });

  app.get("/events", async (req, reply) => {
    const q = z.object({ caseId: z.string().uuid() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "caseId required" });
    return { events: await deps.events.forCase(q.data.caseId) };
  });

  app.post("/cases/:id/recover", requireAuth, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await deps.cases.byId(id))) return reply.code(404).send({ error: "not found" });
    await enqueueRecovery(deps.queue, id);
    return reply.code(202).send({ queued: true });
  });

  const stopBody = z.object({ note: z.string().max(500).optional() });

  // Never aborts a call already in flight to Razorpay or the model — see StopRegistry. A case
  // actively investigating settles at its next checkpoint (up to the agent's own deadline); an
  // idle or scheduled-but-not-yet-running case resolves to STOPPED immediately.
  app.post("/cases/:id/stop", requireAuth, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = stopBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!(await deps.cases.byId(id))) return reply.code(404).send({ error: "not found" });
    await deps.pipeline.requestStop(id, { reason: "user_requested", note: body.data.note });
    return { stopped: true };
  });

  // The emergency brake: no case anywhere in the room starts a new step until /resume. Live
  // idle/parked cases resolve to STOPPED immediately; the response's stoppedNow count is exactly
  // how many. In-flight cases catch it at their own next checkpoint.
  app.post("/stop", requireAuth, async (req, reply) => {
    const body = stopBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const result = await deps.pipeline.requestStopAll({ reason: "user_requested", note: body.data.note });
    return { stopped: true, ...result };
  });

  // Lifts the emergency brake only — does not touch any per-case stop, and does not revive a
  // case already resolved to STOPPED.
  app.post("/resume", requireAuth, async () => {
    deps.pipeline.resumeAll();
    return { resumed: true };
  });

  // Proves the append-only guarantee rather than asserting it: connects as the app DB role and
  // tries to UPDATE recovery_events, expecting the database to refuse.
  app.get("/cases/:id/audit/verify", async () => deps.verifyAppendOnly());

  app.post("/cases/:id/decision", requireAuth, async (req, reply) => {
    const { id } = req.params as { id: string };
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

    // Recorded before the case moves, so the directive is durably in the audit trail before any
    // worker can pick the case up. The next pipeline turn reads it, performs exactly this action
    // instead of re-running the agent, and carries the authorization into the gate — which still
    // runs, and still refuses a hard decline or an attempt past the cap.
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
    await enqueueRecovery(deps.queue, id);
    return { applied: body.data.decision, action: action.kind };
  });

  // The room-wide feed: every durable event across every case, so the top bar and case lists can
  // update from the same canonical stream instead of a 2s poll of the full case list.
  app.get("/stream", async (req, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "open" });

    // Subscribe before the initial metrics read, so an event landing during that read is not
    // missed between the snapshot and the first live frame.
    const unsubscribe = deps.bus.subscribeRoom(send);
    send({ type: "metrics", ...(await deps.cases.metrics()), braked: deps.pipeline.isBraked() });
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  app.get("/cases/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "open", caseId: id });

    // Subscribe before reading the lane, so a run starting during the read is not missed. The
    // status that follows says whether a worker is actually holding this case: without it a
    // client cannot tell a live run from a finished one it has merely opened, and every
    // historical case looks like an agent stuck mid-investigation.
    const unsubscribe = deps.bus.subscribe(id, send);
    const kase = await deps.cases.byId(id);
    if (kase) send({ type: "status", lane: kase.lane, active: IN_FLIGHT_LANES.includes(kase.lane) });
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // Demo aid: stands in for the customer completing payment on Razorpay's mock bank page. Builds
  // a real signed webhook for the pending order and runs it through the same handler a real
  // Razorpay delivery hits — the settle and ledger code paths are genuinely exercised.
  app.post("/cases/:id/simulate-capture", requireAuth, async (req, reply) => {
    const { id } = req.params as { id: string };
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
    const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const result = await deps.webhookHandler.handle({ rawBody, signature, eventId });
    const code = result.status === "invalid_signature" ? 401 : result.status === "malformed" ? 400 : 200;
    return reply.code(code).send(result);
  });
}
