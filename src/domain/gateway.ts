import { z } from "zod";

// Our vocabulary for the payment gateway, not Razorpay's. Adapters translate at the boundary.

export const paymentStatus = z.enum(["created", "authorized", "captured", "refunded", "failed"]);
export type PaymentStatus = z.infer<typeof paymentStatus>;

export type GatewayOrder = { id: string; amountPaise: number };

export type GatewayPaymentLink = {
  id: string;
  url: string;
  amountPaise: number;
  status?: "created" | "partially_paid" | "expired" | "cancelled" | "paid";
};

export type GatewayPayment = {
  id: string;
  orderId: string | null;
  amountPaise: number;
  capturedPaise: number;
  status: PaymentStatus;
  method: string | null;
  errorReason: string | null;
};

export type Downtime = {
  id: string;
  method: string;
  severity: string;
  status: string;
  /** Razorpay keys this by rail: issuer for cards, bank for netbanking, vpa_handle for UPI. */
  instrument: Record<string, string>;
  begin: string;
  end: string | null;
};

/**
 * The call reached a definite verdict: the gateway said no. Safe to record as a failure.
 */
export class GatewayRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: string | null,
  ) {
    super(message);
    this.name = "GatewayRejectedError";
  }
}

/**
 * The outcome is unknown — a 5xx, a timeout, a socket hangup. The request may or may not have
 * been applied. Never record this as success or failure; reconcile against the gateway.
 */
export class GatewayUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "GatewayUnavailableError";
  }
}

export interface PaymentGateway {
  createOrder(input: {
    amountPaise: number;
    currency: string;
    idempotencyKey: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder>;

  createPaymentLink(input: {
    amountPaise: number;
    currency: string;
    idempotencyKey: string;
    description: string;
    notes?: Record<string, string>;
  }): Promise<GatewayPaymentLink>;

  getPayment(paymentId: string): Promise<GatewayPayment | null>;

  /** The reconciliation read after an ambiguous create: did the order land anyway? */
  findOrderByIdempotencyKey(idempotencyKey: string): Promise<GatewayOrder | null>;

  findPaymentLinkByIdempotencyKey(idempotencyKey: string): Promise<GatewayPaymentLink | null>;

  listOrderPayments(orderId: string): Promise<GatewayPayment[]>;

  getPaymentLink(linkId: string): Promise<(GatewayPaymentLink & { payments: GatewayPayment[] }) | null>;

  listDowntimes(): Promise<Downtime[]>;
}
