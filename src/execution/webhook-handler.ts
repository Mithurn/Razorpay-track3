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
    if (!fresh) return { status: "duplicate" };

    if (!SETTLING_EVENTS.has(parsed.event)) return { status: "ignored", event: parsed.event };

    const ref =
      parsed.payload.payment?.entity.order_id ??
      parsed.payload.payment_link?.entity.id ??
      parsed.payload.order?.entity.id ??
      null;
    if (!ref) return { status: "malformed" };

    const attempt = await this.attempts.byRazorpayRef(ref);
    if (!attempt) return { status: "unmatched", ref };

    const kase = await this.cases.byId(attempt.caseId);
    if (!kase) return { status: "unmatched", ref };

    await this.events.append({
      caseId: attempt.caseId,
      type: "ATTEMPT_OUTCOME",
      payload: { via: "webhook", event: parsed.event, ref },
    });

    const settled = await this.executor.settle(attempt, kase.amountPaise, reconstructAction(attempt.action));
    return { status: "processed", attemptStatus: settled.status };
  }
}
