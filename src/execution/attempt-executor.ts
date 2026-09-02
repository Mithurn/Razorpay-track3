import type { AttemptRepository, EventLog, OutcomeResolver } from "../domain/ports.js";
import type { Attempt, AttemptRequest } from "../domain/attempt.js";
import { idempotencyKeyFor } from "../domain/attempt.js";
import type { RecoveryAction } from "../domain/recovery-action.js";
import { GatewayRejectedError, GatewayUnavailableError, type PaymentGateway } from "../domain/gateway.js";
import { RazorpayClient } from "./razorpay-client.js";

// Performs one decided recovery action exactly once. The attempt row (with its unique
// idempotency key) is claimed before any Razorpay call, so a crash mid-flight leaves a durable
// claim rather than a lost or doubled attempt. An ambiguous gateway response is never read as
// success or failure — it parks the attempt for settle() to resolve later.

const MOVES_MONEY: ReadonlySet<RecoveryAction["kind"]> = new Set(["RETRY_NOW", "RETRY_SCHEDULED", "PAYMENT_LINK"]);

export class AttemptExecutor {
  constructor(
    private readonly attempts: AttemptRepository,
    private readonly events: EventLog,
    private readonly gateway: PaymentGateway,
    private readonly resolver: OutcomeResolver,
  ) {}

  async execute(request: AttemptRequest): Promise<Attempt> {
    const key = idempotencyKeyFor(request.caseId, request.attemptNo);
    const attempt = await this.attempts.claim(request, key);

    // A retry after a crash lands on a row that already reached a verdict — replay it, do nothing.
    if (attempt.status !== "PENDING") return attempt;

    await this.events.append({
      caseId: request.caseId,
      type: "ATTEMPT_STARTED",
      payload: { attemptNo: request.attemptNo, action: request.action, clamped: request.clamp !== null },
    });

    try {
      const ref = await this.perform(attempt, request, key);
      await this.settleFromVerdict(attempt.id, request.caseId, request.action, ref, request.amountPaise);
    } catch (err) {
      if (err instanceof GatewayUnavailableError) {
        await this.attempts.resolve(attempt.id, { status: "AWAITING_RECONCILIATION", detail: err.message });
      } else if (err instanceof GatewayRejectedError) {
        await this.attempts.resolve(attempt.id, { status: "FAILED", detail: err.reason ?? err.message });
      } else {
        throw err;
      }
    }

    return this.finish(request.caseId, attempt.id);
  }

  /** Re-check a parked attempt against the gateway. Used by the webhook handler and the sweep. */
  async settle(attempt: Attempt, amountPaise: number, action: RecoveryAction): Promise<Attempt> {
    if (attempt.status !== "PENDING" && attempt.status !== "AWAITING_RECONCILIATION") return attempt;

    let ref = attempt.razorpayRef;
    if (!ref && MOVES_MONEY.has(action.kind)) {
      const order = await this.gateway.findOrderByIdempotencyKey(attempt.idempotencyKey);
      const link = order ? null : await this.gateway.findPaymentLinkByIdempotencyKey(attempt.idempotencyKey);
      ref = order?.id ?? link?.id ?? null;
      if (ref) await this.attempts.recordRazorpayRef(attempt.id, ref);
    }

    await this.settleFromVerdict(attempt.id, attempt.caseId, action, ref, amountPaise);
    return this.finish(attempt.caseId, attempt.id);
  }

  private async perform(attempt: Attempt, request: AttemptRequest, key: string): Promise<string | null> {
    const { action } = request;
    if (action.kind === "RETRY_NOW" || action.kind === "RETRY_SCHEDULED") {
      const order = await this.gateway.createOrder({
        amountPaise: request.amountPaise,
        currency: request.currency,
        idempotencyKey: key,
        notes: { caseId: request.caseId, attemptNo: String(request.attemptNo) },
      });
      await this.attempts.recordRazorpayRef(attempt.id, order.id);
      return order.id;
    }

    if (action.kind === "PAYMENT_LINK") {
      return this.createOrRecoverLink(attempt.id, request, key);
    }

    if (action.kind === "CUSTOMER_NUDGE") {
      await this.events.append({
        caseId: request.caseId,
        type: "ATTEMPT_STARTED",
        payload: { nudgeChannel: action.channel, attemptNo: request.attemptNo },
      });
      return null;
    }

    // ESCALATE / WRITE_OFF touch no money; the worker moves the case lane.
    const detail = action.kind === "ESCALATE" ? "escalated_to_human" : "written_off";
    await this.attempts.resolve(attempt.id, { status: "FAILED", detail });
    return null;
  }

  private async createOrRecoverLink(attemptId: string, request: AttemptRequest, key: string): Promise<string> {
    try {
      const link = await this.gateway.createPaymentLink({
        amountPaise: request.amountPaise,
        currency: request.currency,
        idempotencyKey: key,
        description: `Recovery for ${request.caseId}`,
        notes: { caseId: request.caseId, attemptNo: String(request.attemptNo) },
      });
      await this.attempts.recordRazorpayRef(attemptId, link.id);
      return link.id;
    } catch (err) {
      if (RazorpayClient.isDuplicateReference(err)) {
        const existing = await this.gateway.findPaymentLinkByIdempotencyKey(key);
        if (!existing) throw new GatewayUnavailableError("duplicate link reported but not found yet");
        await this.attempts.recordRazorpayRef(attemptId, existing.id);
        return existing.id;
      }
      throw err;
    }
  }

  private async settleFromVerdict(
    attemptId: string,
    caseId: string,
    action: RecoveryAction,
    razorpayRef: string | null,
    amountPaise: number,
  ): Promise<void> {
    if (action.kind === "ESCALATE" || action.kind === "WRITE_OFF") return;

    const verdict = await this.resolver.resolve({ caseId, action, razorpayRef, amountPaise });
    if (verdict.kind === "recovered") {
      await this.attempts.settleRecovered(attemptId, verdict.capturedPaise, verdict.paymentId);
    } else if (verdict.kind === "failed") {
      await this.attempts.resolve(attemptId, { status: "FAILED", detail: verdict.detail });
    }
    // pending: the row stays PENDING for a webhook or a later sweep.
  }

  private async finish(caseId: string, attemptId: string): Promise<Attempt> {
    const settled = await this.attempts.byId(attemptId);
    if (!settled) throw new Error(`attempt ${attemptId} vanished mid-execution`);
    await this.events.append({
      caseId,
      type: "ATTEMPT_OUTCOME",
      payload: {
        attemptNo: settled.attemptNo,
        status: settled.status,
        detail: settled.detail,
        recoveredPaise: settled.recoveredPaise,
        razorpayRef: settled.razorpayRef,
      },
    });
    return settled;
  }
}
