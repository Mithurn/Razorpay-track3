import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  AttemptRepository,
  CaseEnqueuer,
  CaseRepository,
  EventLog,
  NewCase,
  WebhookInbox,
} from "../domain/ports.js";
import type { AttemptExecutor } from "./attempt-executor.js";
import type { RazorpayClient } from "./razorpay-client.js";
import { reconstructAction } from "./action-codec.js";

const paymentEntity = z.object({
  id: z.string(),
  order_id: z.string().nullable().optional(),
  amount: z.number(),
  status: z.string(),
  method: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
  error_reason: z.string().nullable().optional(),
  error_description: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  contact: z.string().nullable().optional(),
  bank: z.string().nullable().optional(),
  vpa: z.string().nullable().optional(),
  card: z.object({ issuer: z.string().nullable().optional() }).nullable().optional(),
});

const eventSchema = z.object({
  event: z.string(),
  payload: z.object({
    payment: z.object({ entity: paymentEntity }).optional(),
    payment_link: z.object({ entity: z.object({ id: z.string() }) }).optional(),
    order: z.object({ entity: z.object({ id: z.string() }) }).optional(),
  }),
});

export type WebhookResult =
  | { status: "invalid_signature" }
  | { status: "malformed" }
  | { status: "duplicate" }
  | { status: "ignored"; event: string }
  | { status: "unmatched"; ref: string }
  | { status: "processed"; attemptStatus: string }
  | { status: "ingested"; caseId: string };

const SETTLING_EVENTS = new Set(["payment.captured", "payment_link.paid", "order.paid"]);
const INGESTION_EVENTS = new Set(["payment.failed"]);

function instrumentOf(p: z.infer<typeof paymentEntity>): Record<string, string> | null {
  if (p.card?.issuer) return { issuer: p.card.issuer };
  if (p.bank) return { bank: p.bank };
  if (p.vpa) return { vpa_handle: p.vpa };
  return null;
}

function caseFromFailedPayment(p: z.infer<typeof paymentEntity>, merchantRef: string): NewCase {
  return {
    id: randomUUID(),
    runId: null,
    merchantRef,
    customerRef: p.email ?? p.contact ?? `razorpay_${p.id}`,
    originalPaymentId: p.id,
    amountPaise: p.amount,
    currency: "INR",
    failureCode: p.error_code ?? "UNKNOWN",
    failureReason: p.error_reason ?? p.error_description ?? "payment_failed",
    failedAt: new Date().toISOString(),
    method: p.method ?? null,
    instrument: instrumentOf(p),
    customerHistory: [],
  };
}

export class WebhookHandler {
  constructor(
    private readonly client: RazorpayClient,
    private readonly inbox: WebhookInbox,
    private readonly attempts: AttemptRepository,
    private readonly cases: CaseRepository,
    private readonly events: EventLog,
    private readonly executor: AttemptExecutor,
    private readonly enqueuer: CaseEnqueuer,
    private readonly merchantRef: string,
  ) {}

  async handle(input: { rawBody: string; signature: string; eventId: string }): Promise<WebhookResult> {
    if (!this.client.verifyWebhook(input.rawBody, input.signature)) return { status: "invalid_signature" };

    let parsed: z.infer<typeof eventSchema>;
    try {
      parsed = eventSchema.parse(JSON.parse(input.rawBody));
    } catch {
      return { status: "malformed" };
    }

    const fresh = await this.inbox.recordIfNew(input.eventId, parsed.event, JSON.parse(input.rawBody));

    if (INGESTION_EVENTS.has(parsed.event)) {
      if (!fresh) return { status: "duplicate" };
      const payment = parsed.payload.payment?.entity;
      if (!payment) return { status: "malformed" };
      const existing = await this.cases.byOriginalPaymentId(payment.id);
      if (existing) return { status: "ingested", caseId: existing.id };
      const kase = await this.cases.create(caseFromFailedPayment(payment, this.merchantRef));
      await this.enqueuer.enqueue(kase.id);
      return { status: "ingested", caseId: kase.id };
    }

    if (!SETTLING_EVENTS.has(parsed.event)) return fresh ? { status: "ignored", event: parsed.event } : { status: "duplicate" };

    const ref =
      parsed.payload.payment?.entity.order_id ??
      parsed.payload.payment_link?.entity.id ??
      parsed.payload.order?.entity.id ??
      null;
    if (!ref) return { status: "malformed" };

    const attempt = await this.attempts.byRazorpayRef(ref);
    if (!attempt) return { status: "unmatched", ref };

    // A redelivery of a recorded event id is a true no-op only once its attempt is settled — an
    // unsettled one means the first delivery never finished, and this is the only signal left.
    if (!fresh && attempt.status !== "PENDING" && attempt.status !== "AWAITING_RECONCILIATION") {
      return { status: "duplicate" };
    }

    const kase = await this.cases.byId(attempt.caseId);
    if (!kase) return { status: "unmatched", ref };

    const captured = parsed.payload.payment?.entity;
    const simulated = captured?.id?.startsWith("pay_sim_") ?? false;

    if (fresh) {
      await this.events.append({
        caseId: attempt.caseId,
        type: "ATTEMPT_OUTCOME",
        payload: { via: "webhook", event: parsed.event, ref, simulated, activity: "execute" },
      });
    }

    // A payment.captured webhook carrying a captured entity is Razorpay's authoritative signal
    // that the money landed — settle directly from it. Other settling events fall back to a
    // gateway re-check.
    let status: string;
    if (parsed.event === "payment.captured" && captured?.status === "captured") {
      const credited = await this.attempts.settleRecovered(attempt.id, captured.amount, captured.id);
      status = credited || attempt.status === "RECOVERED" ? "RECOVERED" : attempt.status;
    } else {
      status = (await this.executor.settle(attempt, kase.amountPaise, reconstructAction(attempt.action))).status;
    }

    if (status === "RECOVERED" && !["RECOVERED", "ESCALATED", "WRITTEN_OFF"].includes(kase.lane)) {
      await this.cases.moveLane(kase.id, kase.lane, "RECOVERED");
      await this.events.append({
        caseId: kase.id,
        type: "CASE_RESOLVED",
        payload: { lane: "RECOVERED", via: "webhook", simulated, activity: "outcome" },
      });
    }
    return { status: "processed", attemptStatus: status };
  }
}
