import { randomUUID } from "node:crypto";
import type {
  Downtime,
  GatewayOrder,
  GatewayPayment,
  GatewayPaymentLink,
  PaymentGateway,
} from "../src/domain/gateway.js";

// The bench creates orders and links in memory rather than against Razorpay. The exactly-once
// and reconciliation guarantees are proven by the executor's own integration tests; the bench
// measures recovery policy, and 500 live order creates would only add rate-limit flakiness.
// The downtime feed is the exception — it is loaded once from the real Razorpay response so the
// agent's downtime tool sees genuine data.
//
// Refs are UUID-based: a per-instance counter collided across cases (a fresh BenchGateway per
// case in seed-room.ts), which razorpay_ref's DB uniqueness constraint must never see happen.

export class BenchGateway implements PaymentGateway {
  constructor(private readonly downtimes: Downtime[]) {}

  async createOrder(input: { amountPaise: number }): Promise<GatewayOrder> {
    return { id: `order_bench_${randomUUID()}`, amountPaise: input.amountPaise };
  }
  async createPaymentLink(input: { amountPaise: number }): Promise<GatewayPaymentLink> {
    return { id: `plink_bench_${randomUUID()}`, url: "https://bench.local/x", amountPaise: input.amountPaise };
  }
  async getPayment(): Promise<GatewayPayment | null> {
    return null;
  }
  async findOrderByIdempotencyKey(): Promise<GatewayOrder | null> {
    return null;
  }
  async findPaymentLinkByIdempotencyKey(): Promise<GatewayPaymentLink | null> {
    return null;
  }
  async listOrderPayments(): Promise<GatewayPayment[]> {
    return [];
  }
  async getPaymentLink() {
    return null;
  }
  async listDowntimes(): Promise<Downtime[]> {
    return this.downtimes;
  }
}
