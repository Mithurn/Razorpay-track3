import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RazorpayClient, RazorpayOrder, RazorpayPayment, WebhookEnvelope } from "./razorpay.js";
import { RazorpayNotFound, RazorpayRequestConflict, RazorpayServerError } from "./razorpay.js";

const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  receipt: z.string().nullish(),
  amount: z.number(),
});

const paymentSchema = z.object({
  id: z.string(),
  order_id: z.string().nullable().optional(),
  status: z.string(),
  amount: z.number(),
});

const webhookEnvelopeSchema = z.object({
  event: z.string(),
  payload: z
    .object({
      payment: z
        .object({
          id: z.string(),
          order_id: z.string().nullable().optional(),
          status: z.string(),
          amount: z.number(),
        })
        .optional(),
    })
    .optional(),
});

export class RazorpayHttpClient implements RazorpayClient {
  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly webhookSecret: string,
    private readonly baseUrl = "https://api.razorpay.com/v1",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder> {
    const body = await this.request(
      "POST /orders",
      "/orders",
      "POST",
      {
        amount: input.amountPaise,
        currency: "INR",
        receipt: input.receipt,
        notes: input.notes,
      },
    );
    const order = orderSchema.parse(body);
    return { ...order, receipt: order.receipt ?? null };
  }

  async getPaymentsForOrder(orderId: string): Promise<RazorpayPayment[]> {
    const body = await this.request("GET /orders/:id/payments", `/orders/${orderId}/payments`, "GET");
    const items = z.object({ items: z.array(paymentSchema) }).parse(body);
    return items.items.map(parsePayment);
  }

  async getPayment(paymentId: string): Promise<RazorpayPayment | null> {
    try {
      const body = await this.request("GET /payments/:id", `/payments/${paymentId}`, "GET");
      return parsePayment(paymentSchema.parse(body));
    } catch (error) {
      if (error instanceof RazorpayNotFound) return null;
      throw error;
    }
  }

  async capture(paymentId: string, input: { amountPaise: number }): Promise<RazorpayPayment> {
    const body = await this.request(
      "POST /payments/:id/capture",
      `/payments/${paymentId}/capture`,
      "POST",
      { amount: input.amountPaise, currency: "INR" },
    );
    return parsePayment(paymentSchema.parse(body));
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): WebhookEnvelope | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return null;
    }
    const envelope = webhookEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) return null;
    return {
      event: envelope.data.event,
      eventId: extractEventId(parsed),
      payment: envelope.data.payload?.payment
        ? {
            id: envelope.data.payload.payment.id,
            orderId: envelope.data.payload.payment.order_id ?? null,
            status: envelope.data.payload.payment.status,
            amount: envelope.data.payload.payment.amount,
          }
        : null,
    };
  }

  private async request(
    _label: string,
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: [
        ["Content-Type", "application/json"],
        ["Authorization", `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`],
      ],
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (response.status === 404) {
      throw new RazorpayNotFound();
    }
    if (response.status >= 500 || response.status === 429) {
      throw new RazorpayServerError(response.status, text);
    }
    if (!response.ok) {
      throw new RazorpayRequestConflict(response.status, text);
    }
    return text ? JSON.parse(text) : null;
  }
}

function parsePayment(raw: z.infer<typeof paymentSchema>): RazorpayPayment {
  return {
    id: raw.id,
    order_id: raw.order_id ?? null,
    status: raw.status,
    amount: raw.amount,
  };
}

function extractEventId(parsed: unknown): string | null {
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (typeof record.event_id === "string") return record.event_id;
    const account = record.account_event ?? record.__account_event;
    if (account && typeof account === "object") {
      const eventId = (account as Record<string, unknown>).event_id;
      if (typeof eventId === "string") return eventId;
    }
  }
  return null;
}
