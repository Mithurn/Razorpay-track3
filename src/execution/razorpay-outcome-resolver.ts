import type { OutcomeResolver, OutcomeVerdict } from "../domain/ports.js";
import type { RecoveryAction } from "../domain/recovery-action.js";
import type { PaymentGateway } from "../domain/gateway.js";

// The live lane's verdict: read the real payments behind the order or link. A payment only
// counts as recovered when Razorpay reports it captured; anything else is pending or failed,
// never assumed.

export class RazorpayOutcomeResolver implements OutcomeResolver {
  constructor(private readonly gateway: PaymentGateway) {}

  async resolve(input: {
    caseId: string;
    action: RecoveryAction;
    razorpayRef: string | null;
    amountPaise: number;
  }): Promise<OutcomeVerdict> {
    if (input.action.kind === "CUSTOMER_NUDGE") return { kind: "pending" };
    if (!input.razorpayRef) return { kind: "pending" };

    const payments =
      input.action.kind === "PAYMENT_LINK"
        ? ((await this.gateway.getPaymentLink(input.razorpayRef))?.payments ?? [])
        : await this.gateway.listOrderPayments(input.razorpayRef);

    const captured = payments.find((p) => p.status === "captured" && p.capturedPaise > 0);
    if (captured) return { kind: "recovered", capturedPaise: captured.capturedPaise, paymentId: captured.id };

    const failed = payments.find((p) => p.status === "failed");
    if (failed && payments.every((p) => p.status === "failed")) {
      return { kind: "failed", detail: failed.errorReason ?? "payment failed" };
    }

    return { kind: "pending" };
  }
}
