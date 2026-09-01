import type { Pool } from "pg";
import { proposalSchema } from "../domain/mandate.js";
import { ExecutionStore } from "./store.js";
import type { Executor } from "./executor.js";
import type { RazorpayClient } from "./razorpay.js";

export type WebhookResult =
  | { handled: "accepted" }
  | { handled: "bad_signature" }
  | { handled: "duplicate" }
  | { handled: "ignored"; reason: string };

export function createWebhookHandler(deps: {
  pool: Pool;
  razorpay: RazorpayClient;
  store: ExecutionStore;
  executor: Executor;
}) {
  const { pool, razorpay, store, executor } = deps;

  return async function handleWebhook(rawBody: string, signature: string | undefined): Promise<WebhookResult> {
    if (!signature || !razorpay.verifyWebhookSignature(rawBody, signature)) {
      return { handled: "bad_signature" };
    }

    const envelope = razorpay.parseWebhook(rawBody);
    if (!envelope) {
      return { handled: "ignored", reason: "unparseable_payload" };
    }

    if (envelope.eventId) {
      const firstDelivery = await store.recordWebhookEventId(envelope.eventId, envelope.event);
      if (!firstDelivery) {
        return { handled: "duplicate" };
      }
    }

    const orderId = envelope.payment?.orderId;
    if (!orderId) {
      return { handled: "ignored", reason: "no_order_reference" };
    }

    const job = await findJobByOrderId(pool, orderId);
    if (!job) {
      return { handled: "ignored", reason: "unknown_order" };
    }

    await store.recordEvent(job.correlationId, {
      event: "WEBHOOK_RECEIVED",
      state: job.state,
      razorpayRef: envelope.payment?.id ?? orderId,
      payload: { webhookEvent: envelope.event, remoteStatus: envelope.payment?.status },
    });

    const amountPaise = await proposalAmount(pool, job.correlationId);
    if (job.state === "CAPTURING" || job.state === "AWAITING_RECONCILIATION") {
      // Never act while a capture is in flight or unknown; reconciliation owns the truth.
      return { handled: "accepted" };
    }
    // Webhooks are hints: advance re-polls the live order status and moves forward only.
    await executor.advance(job, amountPaise);
    return { handled: "accepted" };
  };
}

async function findJobByOrderId(pool: Pool, orderId: string) {
  const result = await pool.query(
    `SELECT correlation_id, state, order_id, payment_id, attempt
     FROM executor_jobs WHERE order_id = $1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    correlationId: row.correlation_id,
    state: row.state,
    orderId: row.order_id,
    paymentId: row.payment_id,
    attempt: row.attempt,
  };
}

async function proposalAmount(pool: Pool, correlationId: string): Promise<number> {
  const result = await pool.query(
    `SELECT proposal FROM mandate_decisions WHERE correlation_id = $1 AND decision = 'ALLOW'`,
    [correlationId],
  );
  const parsed = proposalSchema.safeParse(result.rows[0]?.proposal);
  return parsed.success ? parsed.data.amountPaise : 0;
}
