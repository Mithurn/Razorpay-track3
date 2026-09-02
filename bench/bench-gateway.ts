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

export class BenchGateway implements PaymentGateway {
  private orders = 0;
  private links = 0;

  constructor(private readonly downtimes: Downtime[]) {}

  async createOrder(input: { amountPaise: number }): Promise<GatewayOrder> {
    return { id: `order_bench_${++this.orders}`, amountPaise: input.amountPaise };
  }
  async createPaymentLink(input: { amountPaise: number }): Promise<GatewayPaymentLink> {
    return { id: `plink_bench_${++this.links}`, url: "https://bench.local/x", amountPaise: input.amountPaise };
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
