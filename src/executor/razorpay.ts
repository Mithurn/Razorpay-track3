export type RazorpayOrder = {
  id: string;
  status: string;
  receipt: string | null;
  amount: number;
};

export type RazorpayPayment = {
  id: string;
  order_id: string | null;
  status: string;
  amount: number;
};

export type CreatedOrder = RazorpayOrder;

export interface RazorpayClient {
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<CreatedOrder>;
  getPaymentsForOrder(orderId: string): Promise<RazorpayPayment[]>;
  getPayment(paymentId: string): Promise<RazorpayPayment | null>;
  capture(paymentId: string, input: { amountPaise: number }): Promise<RazorpayPayment>;
  verifyWebhookSignature(rawBody: string, signature: string): boolean;
  parseWebhook(rawBody: string): WebhookEnvelope | null;
}

export type WebhookEnvelope = {
  event: string;
  eventId: string | null;
  payment: {
    id: string;
    orderId: string | null;
    status: string;
    amount: number;
  } | null;
};

export class RazorpayServerError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Razorpay server error ${status}`);
  }
}

export class RazorpayRequestConflict extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`Razorpay conflict ${status}`);
  }
}

export class RazorpayNotFound extends Error {}
