import { z } from "zod";

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

export class GatewayRejectedError extends Error {
  constructor(
    message: string,
    readonly reason: string | null,
  ) {
    super(message);
    this.name = "GatewayRejectedError";
  }
}

// Outcome unknown — never record as success or failure; reconcile against the gateway instead.
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

  /** The reconciliation read after an ambiguous create: did the order land anyway? */
  findOrderByIdempotencyKey(idempotencyKey: string): Promise<GatewayOrder | null>;

  findPaymentLinkByIdempotencyKey(idempotencyKey: string): Promise<GatewayPaymentLink | null>;

  listOrderPayments(orderId: string): Promise<GatewayPayment[]>;

  getPaymentLink(linkId: string): Promise<(GatewayPaymentLink & { payments: GatewayPayment[] }) | null>;

  listDowntimes(): Promise<Downtime[]>;
}
