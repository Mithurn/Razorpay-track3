import type { AttemptRepository, EventLog, NotificationPort, OutcomeResolver } from "../domain/ports.js";
import type { Attempt, AttemptRequest, AttemptStatus } from "../domain/attempt.js";
import { idempotencyKeyFor } from "../domain/attempt.js";
import { MOVES_MONEY, type RecoveryAction } from "../domain/recovery-action.js";
import { GatewayRejectedError, GatewayUnavailableError, type PaymentGateway } from "../domain/gateway.js";
import { RazorpayClient } from "./razorpay-client.js";

// Performs one decided recovery action exactly once. The attempt row (with its unique
// idempotency key) is claimed before any Razorpay call, so a crash mid-flight leaves a durable
// claim rather than a lost or doubled attempt. An ambiguous gateway response is never read as
// success or failure — it parks the attempt for settle() to resolve later.

const TERMINAL_ACTION_DETAIL: Partial<Record<RecoveryAction["kind"], string>> = {
  ESCALATE: "escalated_to_human",
  WRITE_OFF: "written_off",
};

export class AttemptExecutor {
  constructor(
    private readonly attempts: AttemptRepository,
    private readonly events: EventLog,
    private readonly gateway: PaymentGateway,
    private readonly resolver: OutcomeResolver,
    private readonly notifier: NotificationPort,
    opts: { reperformAfterMs?: number } = {},
  ) {
    // A gateway lookup that misses also matches an order created seconds ago (list-index
    // eventual consistency), so absence is only trusted for claims old enough that the original
    // perform, had it run, could no longer be in flight.
    this.reperformAfterMs = opts.reperformAfterMs ?? 60 * 60_000;
  }

  private readonly reperformAfterMs: number;

  async execute(request: AttemptRequest): Promise<Attempt> {
    const key = idempotencyKeyFor(request.caseId, request.attemptNo);
    const { attempt, created } = await this.attempts.claim(request, key);

    // A concurrent caller that lost the claim does not own this attempt — it must not touch
    // Razorpay. Whatever the row's current status is, settle() (via the pipeline's parked-
    // attempt path) is what reconciles it, not a second perform().
    if (!created) return attempt;

    await this.events.append({
      caseId: request.caseId,
      type: "ATTEMPT_STARTED",
      payload: {
        attemptNo: request.attemptNo,
        action: request.action,
        clamped: request.clamp !== null,
        activity: "execute",
      },
    });

    try {
      const ref = await this.perform(attempt, request, key);
      await this.settleFromVerdict(attempt.id, request.caseId, request.action, ref, request.amountPaise);
      await this.closeUnobservableNudge(attempt.id, request.action);
    } catch (err) {
      if (err instanceof GatewayUnavailableError) {
        await this.attempts.resolve(attempt.id, { status: "AWAITING_RECONCILIATION", detail: err.message });
      } else if (err instanceof GatewayRejectedError) {
        await this.attempts.resolve(attempt.id, { status: "FAILED", detail: err.reason ?? err.message });
      } else {
        throw err;
      }
    }

    return this.finish(request.caseId, attempt.id, null);
  }

  /** Re-check a parked attempt against the gateway. Used by the webhook handler and the sweep. */
  async settle(
    attempt: Attempt,
    money: { amountPaise: number; currency: string },
    action: RecoveryAction,
  ): Promise<Attempt> {
    if (attempt.status !== "PENDING" && attempt.status !== "AWAITING_RECONCILIATION") return attempt;

    let ref = attempt.razorpayRef;
    let resolvedByReperform = false;
    if (!ref && MOVES_MONEY.has(action.kind)) {
      const order = await this.gateway.findOrderByIdempotencyKey(attempt.idempotencyKey);
      const link = order ? null : await this.gateway.findPaymentLinkByIdempotencyKey(attempt.idempotencyKey);
      ref = order?.id ?? link?.id ?? null;
      if (ref) {
        await this.attempts.recordRazorpayRef(attempt.id, ref);
      } else if (Date.now() - Date.parse(attempt.createdAt) > this.reperformAfterMs) {
        const reperform = await this.reperform(attempt, money, action);
        ref = reperform.ref;
        resolvedByReperform = reperform.resolved;
      }
    }
    if (!ref && !MOVES_MONEY.has(action.kind) && action.kind !== "CUSTOMER_NUDGE") {
      // ESCALATE/WRITE_OFF perform() resolves the row synchronously, so a claim still PENDING
      // means the process died before it ever ran. Nothing was spent; close it as perform would.
      await this.attempts.resolve(attempt.id, { status: "FAILED", detail: TERMINAL_ACTION_DETAIL[action.kind] });
    }

    if (!resolvedByReperform) {
      await this.settleFromVerdict(attempt.id, attempt.caseId, action, ref, money.amountPaise);
    }
    await this.closeUnobservableNudge(attempt.id, action);
    return this.finish(attempt.caseId, attempt.id, attempt.status);
  }

  // The order/link was never created: the process died between the durable claim and perform.
  // Recreate it under the same idempotency key, then settle as if it had just been performed.
  private async reperform(
    attempt: Attempt,
    money: { amountPaise: number; currency: string },
    action: RecoveryAction,
  ): Promise<{ ref: string | null; resolved: boolean }> {
    try {
      const ref = await this.createFor(attempt, money, action);
      await this.attempts.recordRazorpayRef(attempt.id, ref);
      await this.events.append({
        caseId: attempt.caseId,
        type: "ATTEMPT_REPERFORMED",
        payload: { attemptNo: attempt.attemptNo, razorpayRef: ref, activity: "execute" },
      });
      return { ref, resolved: false };
    } catch (err) {
      if (err instanceof GatewayUnavailableError) {
        await this.attempts.resolve(attempt.id, { status: "AWAITING_RECONCILIATION", detail: err.message });
        return { ref: null, resolved: true };
      }
      if (err instanceof GatewayRejectedError) {
        await this.attempts.resolve(attempt.id, { status: "FAILED", detail: err.reason ?? err.message });
        return { ref: null, resolved: true };
      }
      throw err;
    }
  }

  private createFor(
    attempt: Attempt,
    money: { amountPaise: number; currency: string },
    action: RecoveryAction,
  ): Promise<string> {
    const notes = { caseId: attempt.caseId, attemptNo: String(attempt.attemptNo) };
    if (action.kind === "RETRY_NOW" || action.kind === "RETRY_SCHEDULED") {
      return this.gateway
        .createOrder({
          amountPaise: money.amountPaise,
          currency: money.currency,
          idempotencyKey: attempt.idempotencyKey,
          notes,
        })
        .then((o) => o.id);
    }
    return this.gateway
      .createPaymentLink({
        amountPaise: money.amountPaise,
        currency: money.currency,
        idempotencyKey: attempt.idempotencyKey,
        description: `Recovery for ${attempt.caseId}`,
        notes,
      })
      .then((l) => l.id);
  }

  private async perform(attempt: Attempt, request: AttemptRequest, key: string): Promise<string | null> {
    const { action } = request;
    // RETRY_SCHEDULED's atHoursFromNow spaces out the *next* attempt if this one fails
    // (pipeline.ts's rescheduleDelay); the order below is created now either way, not deferred.
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

    // CUSTOMER_NUDGE moves no money and has no Razorpay ref, but it must still *do* something —
    // it used to return here having sent nothing at all.
    if (action.kind === "CUSTOMER_NUDGE") {
      await this.notifier.send({
        caseId: request.caseId,
        channel: action.channel,
        amountPaise: request.amountPaise,
        currency: request.currency,
      });
      return null;
    }

    // ESCALATE / WRITE_OFF touch no money; the worker moves the case lane.
    await this.attempts.resolve(attempt.id, { status: "FAILED", detail: TERMINAL_ACTION_DETAIL[action.kind]! });
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

  // A nudge has no Razorpay ref, so no webhook or sweep can ever settle it. Left PENDING it would
  // re-check forever; once the message is away there is nothing more to observe, so it ends here.
  private async closeUnobservableNudge(attemptId: string, action: RecoveryAction): Promise<void> {
    if (action.kind !== "CUSTOMER_NUDGE") return;
    const current = await this.attempts.byId(attemptId);
    if (current?.status !== "PENDING") return;
    await this.attempts.resolve(attemptId, {
      status: "FAILED",
      detail: "nudge queued; delivery and customer response are not observable in this build",
    });
  }

  private async finish(caseId: string, attemptId: string, previousStatus: AttemptStatus | null): Promise<Attempt> {
    const settled = await this.attempts.byId(attemptId);
    if (!settled) throw new Error(`attempt ${attemptId} vanished mid-execution`);
    if (previousStatus === null || settled.status !== previousStatus) {
      await this.events.append({
        caseId,
        type: "ATTEMPT_OUTCOME",
        payload: {
          attemptNo: settled.attemptNo,
          status: settled.status,
          detail: settled.detail,
          recoveredPaise: settled.recoveredPaise,
          razorpayRef: settled.razorpayRef,
          activity: "execute",
        },
      });
    }
    return settled;
  }
}
