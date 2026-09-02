import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  GatewayRejectedError,
  GatewayUnavailableError,
  paymentStatus,
  type Downtime,
  type GatewayOrder,
  type GatewayPayment,
  type GatewayPaymentLink,
  type PaymentGateway,
} from "../domain/gateway.js";

const BASE_URL = "https://api.razorpay.com/v1";

// Razorpay caps receipt at 40 chars; our idempotency keys are UUIDs (36).
const orderSchema = z.object({
  id: z.string(),
  amount: z.number(),
  receipt: z.string().nullable().optional(),
});

const paymentLinkSchema = z.object({
  id: z.string(),
  short_url: z.string(),
  amount: z.number(),
});

const paymentSchema = z.object({
  id: z.string(),
  order_id: z.string().nullable().optional(),
  amount: z.number(),
  amount_captured: z.number().nullable().optional(),
  status: z.string(),
  method: z.string().nullable().optional(),
  error_reason: z.string().nullable().optional(),
});

const downtimeSchema = z.object({
  id: z.string(),
  method: z.string(),
  severity: z.string(),
  status: z.string(),
  instrument: z.record(z.string()).default({}),
  begin: z.number(),
  end: z.number().nullable().optional(),
});

function toPayment(raw: z.infer<typeof paymentSchema>): GatewayPayment {
  const status = paymentStatus.safeParse(raw.status);
  return {
    id: raw.id,
    orderId: raw.order_id ?? null,
    amountPaise: raw.amount,
    // Razorpay leaves amount_captured null until capture settles; a captured payment carries the
    // full amount. Never infer a captured value from the requested one.
    capturedPaise: raw.status === "captured" ? (raw.amount_captured ?? raw.amount) : 0,
    status: status.success ? status.data : "failed",
    method: raw.method ?? null,
    errorReason: raw.error_reason ?? null,
  };
}

export type RazorpayCredentials = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

export class RazorpayClient implements PaymentGateway {
  private readonly auth: string;

  constructor(
    private readonly creds: RazorpayCredentials,
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.auth = "Basic " + Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
  }

  private async call(path: string, init?: { method: "POST"; body: unknown }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE_URL}${path}`, {
        method: init ? init.method : "GET",
        headers: {
          authorization: this.auth,
          ...(init ? { "content-type": "application/json" } : {}),
        },
        body: init ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (cause) {
      throw new GatewayUnavailableError(`razorpay ${path}: network error or timeout`, cause);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();

    if (res.status >= 500 || res.status === 429) {
      throw new GatewayUnavailableError(`razorpay ${path}: HTTP ${res.status}`);
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A 2xx we cannot parse is an unknown outcome, not a rejection.
      if (res.ok) throw new GatewayUnavailableError(`razorpay ${path}: unparseable success body`);
      throw new GatewayRejectedError(`razorpay ${path}: HTTP ${res.status}`, null);
    }

    if (!res.ok) {
      const err = z
        .object({ error: z.object({ description: z.string().optional(), reason: z.string().nullable().optional() }) })
        .safeParse(body);
      const description = err.success ? (err.data.error.description ?? text) : text;
      const reason = err.success ? (err.data.error.reason ?? null) : null;
      throw new GatewayRejectedError(`razorpay ${path}: ${description}`, reason);
    }

    return body;
  }

  private parse<T extends z.ZodTypeAny>(schema: T, body: unknown, path: string): z.infer<T> {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new GatewayUnavailableError(`razorpay ${path}: unexpected response shape`, parsed.error);
    }
    return parsed.data;
  }

  async createOrder(input: {
    amountPaise: number;
    currency: string;
    idempotencyKey: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder> {
    const body = await this.call("/orders", {
      method: "POST",
      body: {
        amount: input.amountPaise,
        currency: input.currency,
        receipt: input.idempotencyKey,
        notes: input.notes ?? {},
      },
    });
    const order = this.parse(orderSchema, body, "/orders");
    return { id: order.id, amountPaise: order.amount };
  }

  async createPaymentLink(input: {
    amountPaise: number;
    currency: string;
    idempotencyKey: string;
    description: string;
    notes?: Record<string, string>;
  }): Promise<GatewayPaymentLink> {
    const body = await this.call("/payment_links", {
      method: "POST",
      body: {
        amount: input.amountPaise,
        currency: input.currency,
        description: input.description,
        reference_id: input.idempotencyKey,
        notes: input.notes ?? {},
      },
    });
    const link = this.parse(paymentLinkSchema, body, "/payment_links");
    return { id: link.id, url: link.short_url, amountPaise: link.amount };
  }

  async getPayment(paymentId: string): Promise<GatewayPayment | null> {
    try {
      const body = await this.call(`/payments/${encodeURIComponent(paymentId)}`);
      return toPayment(this.parse(paymentSchema, body, "/payments/:id"));
    } catch (err) {
      if (err instanceof GatewayRejectedError) return null;
      throw err;
    }
  }

  /**
   * Razorpay's order LIST index is eventually consistent — an order created moments ago is absent
   * here while `GET /orders/:id` already returns it. A null therefore means "unknown", never "it
   * did not land", so this must only be called by the reconciler on a later pass, never as an
   * inline retry guard. `receipt` is also not unique at Razorpay (duplicates are accepted), so it
   * is a lookup label only; our own attempts.idempotency_key is the real constraint.
   */
  async findOrderByIdempotencyKey(idempotencyKey: string): Promise<GatewayOrder | null> {
    const body = await this.call(`/orders?receipt=${encodeURIComponent(idempotencyKey)}`);
    const list = this.parse(z.object({ items: z.array(orderSchema).default([]) }), body, "/orders?receipt");
    const match = list.items.find((o) => o.receipt === idempotencyKey);
    return match ? { id: match.id, amountPaise: match.amount } : null;
  }

  async findPaymentLinkByIdempotencyKey(idempotencyKey: string): Promise<GatewayPaymentLink | null> {
    const body = await this.call(`/payment_links?reference_id=${encodeURIComponent(idempotencyKey)}`);
    const list = this.parse(
      z.object({ payment_links: z.array(paymentLinkSchema).default([]) }),
      body,
      "/payment_links?reference_id",
    );
    const match = list.payment_links[0];
    return match ? { id: match.id, url: match.short_url, amountPaise: match.amount } : null;
  }

  /** True when Razorpay refused a payment link because this key already created one. */
  static isDuplicateReference(err: unknown): boolean {
    return err instanceof GatewayRejectedError && /reference_id/i.test(err.message) && /already exists/i.test(err.message);
  }

  async listOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    const body = await this.call(`/orders/${encodeURIComponent(orderId)}/payments`);
    const list = this.parse(
      z.object({ items: z.array(paymentSchema).default([]) }),
      body,
      "/orders/:id/payments",
    );
    return list.items.map(toPayment);
  }

  async listDowntimes(): Promise<Downtime[]> {
    const body = await this.call("/payments/downtimes");
    const list = this.parse(
      z.object({ items: z.array(downtimeSchema).default([]) }),
      body,
      "/payments/downtimes",
    );
    return list.items.map((d) => ({
      id: d.id,
      method: d.method,
      severity: d.severity,
      status: d.status,
      instrument: d.instrument,
      begin: new Date(d.begin * 1000).toISOString(),
      end: d.end ? new Date(d.end * 1000).toISOString() : null,
    }));
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    const expected = createHmac("sha256", this.creds.webhookSecret).update(rawBody).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, "hex");
    } catch {
      return false;
    }
    return expected.length === received.length && timingSafeEqual(expected, received);
  }
}
