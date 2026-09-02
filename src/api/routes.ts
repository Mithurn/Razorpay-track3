import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Queue } from "bullmq";
import type { AttemptRepository, CaseRepository, EventLog } from "../domain/ports.js";
import type { RunRepository } from "../persistence/run-repository.js";
import type { WebhookHandler } from "../execution/webhook-handler.js";
import type { CaseEventBus } from "./event-bus.js";
import type { RecoveryJob } from "../worker/queue.js";
import { RECOVERY_QUEUE } from "../worker/queue.js";

export type RouteDeps = {
  cases: CaseRepository;
  attempts: AttemptRepository;
  events: EventLog;
  runs: RunRepository;
  queue: Queue<RecoveryJob>;
  webhookHandler: WebhookHandler;
  bus: CaseEventBus;
  modelHealth: () => Promise<{ model: string; reachable: boolean; detail?: string }>;
  razorpayWebhookSecret: string;
};

const decisionBody = z.object({
  decision: z.enum(["approve", "redirect", "write_off"]),
  redirectTo: z.enum(["RETRY_NOW", "PAYMENT_LINK", "CUSTOMER_NUDGE"]).optional(),
  note: z.string().max(500).optional(),
});

export async function registerRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  app.get("/cases", async () => ({ cases: await deps.cases.listLive() }));

  app.get("/queue", async () => ({ cases: await deps.cases.listByLane("ESCALATED") }));

  app.get("/model-health", async () => deps.modelHealth());

  app.get("/scoreboard", async () => deps.runs.latestByArm());

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

  app.post("/cases/:id/recover", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await deps.cases.byId(id))) return reply.code(404).send({ error: "not found" });
    await deps.queue.add(RECOVERY_QUEUE, { caseId: id });
    return reply.code(202).send({ queued: true });
  });

  app.post("/cases/:id/decision", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = decisionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const kase = await deps.cases.byId(id);
    if (!kase) return reply.code(404).send({ error: "not found" });
    if (kase.lane !== "ESCALATED") return reply.code(409).send({ error: "case is not awaiting a decision" });

    await deps.events.append({
      caseId: id,
      type: "CASE_RESOLVED",
      payload: { via: "human", ...body.data },
    });
    if (body.data.decision === "write_off") {
      await deps.cases.moveLane(id, "ESCALATED", "WRITTEN_OFF");
    } else {
      await deps.cases.moveLane(id, "ESCALATED", "RETRY_SCHEDULED");
      await deps.queue.add(RECOVERY_QUEUE, { caseId: id });
    }
    return { applied: body.data.decision };
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
    const unsubscribe = deps.bus.subscribe(id, send);
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  // Demo aid: stands in for the customer completing payment on Razorpay's mock bank page. Builds
  // a real signed webhook for the pending order and runs it through the same handler a real
  // Razorpay delivery hits — the settle and ledger code paths are genuinely exercised.
  app.post("/cases/:id/simulate-capture", async (req, reply) => {
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
