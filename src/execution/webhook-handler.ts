import { z } from "zod";
import type { AttemptRepository, CaseRepository, EventLog, WebhookInbox } from "../domain/ports.js";
import type { AttemptExecutor } from "./attempt-executor.js";
import type { RazorpayClient } from "./razorpay-client.js";
import { reconstructAction } from "./action-codec.js";

const paymentEntity = z.object({
  id: z.string(),
  order_id: z.string().nullable().optional(),
  amount: z.number(),
  status: z.string(),
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
  | { status: "processed"; attemptStatus: string };

const SETTLING_EVENTS = new Set(["payment.captured", "payment_link.paid", "order.paid"]);

export class WebhookHandler {
  constructor(
    private readonly client: RazorpayClient,
    private readonly inbox: WebhookInbox,
    private readonly attempts: AttemptRepository,
    private readonly cases: CaseRepository,
    private readonly events: EventLog,
    private readonly executor: AttemptExecutor,
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

    if (fresh) {
      await this.events.append({
        caseId: attempt.caseId,
        type: "ATTEMPT_OUTCOME",
        payload: { via: "webhook", event: parsed.event, ref },
      });
    }

    // A payment.captured webhook carrying a captured entity is Razorpay's authoritative signal
    // that the money landed — settle directly from it. Other settling events fall back to a
    // gateway re-check.
    const captured = parsed.payload.payment?.entity;
    let status: string;
    if (parsed.event === "payment.captured" && captured?.status === "captured") {
      const credited = await this.attempts.settleRecovered(attempt.id, captured.amount, captured.id);
      status = credited || attempt.status === "RECOVERED" ? "RECOVERED" : attempt.status;
    } else {
      status = (await this.executor.settle(attempt, kase.amountPaise, reconstructAction(attempt.action))).status;
    }

    if (status === "RECOVERED" && !["RECOVERED", "ESCALATED", "WRITTEN_OFF"].includes(kase.lane)) {
      await this.cases.moveLane(kase.id, kase.lane, "RECOVERED");
      await this.events.append({ caseId: kase.id, type: "CASE_RESOLVED", payload: { lane: "RECOVERED", via: "webhook" } });
    }
    return { status: "processed", attemptStatus: status };
  }
}
