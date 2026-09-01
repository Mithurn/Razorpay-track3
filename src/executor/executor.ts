import type { Pool } from "pg";
import { mandatePayloadSchema, proposalSchema, type Proposal } from "../domain/mandate.js";
import { isTerminal, type ExecutionState } from "../domain/execution.js";
import { ExecutionStore, type ExecutorJob } from "./store.js";
import type { RazorpayClient } from "./razorpay.js";
import type { GateClearanceRepository } from "../investigation/gate-clearance.js";

export type ExecutorDeps = {
  pool: Pool;
  razorpay: RazorpayClient;
  store: ExecutionStore;
  gate: GateClearanceRepository;
};

export type ExecutionOutcome = {
  correlationId: string;
  state: ExecutionState;
};

export class Executor {
  private readonly store: ExecutionStore;
  private readonly razorpay: RazorpayClient;
  private readonly pool: Pool;
  private readonly gate: GateClearanceRepository;

  constructor(deps: ExecutorDeps) {
    this.pool = deps.pool;
    this.razorpay = deps.razorpay;
    this.store = deps.store;
    this.gate = deps.gate;
  }

  async execute(correlationId: string): Promise<ExecutionOutcome> {
    const allow = await this.loadAllowDecision(correlationId);
    if (!allow) {
      return { correlationId, state: "FAILED" };
    }
    const proposal = allow.proposal;

    if (!(await this.gatePermitsStart(correlationId))) {
      await this.store.recordEvent(correlationId, {
        event: "FAILED",
        state: "FAILED",
        razorpayRef: null,
        payload: { reason: "investigation_not_cleared" },
      });
      return { correlationId, state: "FAILED" };
    }

    if (!(await this.mandateUnexpired(correlationId))) {
      await this.store.recordEvent(correlationId, {
        event: "FAILED",
        state: "FAILED",
        razorpayRef: null,
        payload: { reason: "mandate_expired_at_execution_time" },
      });
      return { correlationId, state: "FAILED" };
    }

    const created = await this.store.createJobIfAllowed(correlationId);
    if (created) {
      await this.store.recordEvent(correlationId, {
        event: "JOB_CREATED",
        state: "PENDING",
        razorpayRef: null,
        payload: { amountPaise: proposal.amountPaise, merchant: proposal.merchant },
      });
    }
    const job = await this.store.getJob(correlationId);
    if (!job) {
      return { correlationId, state: "FAILED" };
    }
    if (isTerminal(job.state)) {
      return { correlationId, state: job.state };
    }

    return this.advance(job, proposal.amountPaise);
  }

  async sweepStuckJobs(olderThanSeconds = 30): Promise<ExecutionOutcome[]> {
    const stuck = await this.store.jobsInStates(
      ["PENDING", "AWAITING_PAYMENT", "AWAITING_RECONCILIATION", "CAPTURING"],
      olderThanSeconds,
    );
    const outcomes: ExecutionOutcome[] = [];
    for (const job of stuck) {
      const amount = await this.proposalAmount(job.correlationId);
      if (amount === null) {
        await this.fail(job, { reason: "allow_decision_missing_or_unparseable" });
        outcomes.push({ correlationId: job.correlationId, state: "FAILED" });
        continue;
      }
      if (!(await this.mandateUnexpired(job.correlationId))) {
        outcomes.push(await this.fail(job, { reason: "mandate_expired_at_execution_time" }));
        continue;
      }
      outcomes.push(await this.advance(job, amount));
    }
    return outcomes;
  }

  async advance(job: ExecutorJob, amountPaise: number): Promise<ExecutionOutcome> {
    const fresh = (await this.store.getJob(job.correlationId)) ?? job;
    return this.advanceFromState(fresh, amountPaise);
  }

  private async advanceFromState(job: ExecutorJob, amountPaise: number): Promise<ExecutionOutcome> {
    switch (job.state) {
      case "PENDING":
        return this.createOrder(job, amountPaise);
      case "ORDER_CREATED":
        return this.moveToAwaitingPayment(job, amountPaise);
      case "AWAITING_PAYMENT":
        return this.checkForAuthorizedPayment(job, amountPaise);
      case "CAPTURING":
        return this.reconcile(job);
      case "AWAITING_RECONCILIATION":
        return this.reconcile(job);
      case "CAPTURED":
      case "FAILED":
        return { correlationId: job.correlationId, state: job.state };
    }
  }

  private async createOrder(job: ExecutorJob, amountPaise: number): Promise<ExecutionOutcome> {
    try {
      const order = await this.razorpay.createOrder({
        amountPaise,
        receipt: job.correlationId,
        notes: { correlation_id: job.correlationId },
      });
      await this.store.transition(job.correlationId, "ORDER_CREATED", { orderId: order.id });
      await this.store.recordEvent(job.correlationId, {
        event: "ORDER_CREATED",
        state: "ORDER_CREATED",
        razorpayRef: order.id,
        payload: { receipt: job.correlationId, amountPaise },
      });
      const updated = (await this.store.getJob(job.correlationId)) as ExecutorJob;
      return this.advance(updated, amountPaise);
    } catch (error) {
      return this.fail(job, { reason: "order_creation_failed", error: String(error) });
    }
  }

  private async moveToAwaitingPayment(
    job: ExecutorJob,
    amountPaise: number,
  ): Promise<ExecutionOutcome> {
    await this.store.transition(job.correlationId, "AWAITING_PAYMENT");
    const updated = (await this.store.getJob(job.correlationId)) as ExecutorJob;
    return this.advance(updated, amountPaise);
  }

  private async checkForAuthorizedPayment(
    job: ExecutorJob,
    amountPaise: number,
  ): Promise<ExecutionOutcome> {
    if (!job.orderId) {
      return this.fail(job, { reason: "missing_order_id" });
    }
    let payments;
    try {
      payments = await this.razorpay.getPaymentsForOrder(job.orderId);
    } catch (error) {
      return this.fail(job, { reason: "payments_query_failed", error: String(error) });
    }
    const authorized = payments.find((p) => p.status === "authorized" || p.status === "captured");
    if (!authorized) {
      return { correlationId: job.correlationId, state: "AWAITING_PAYMENT" };
    }
    if (authorized.status === "captured") {
      await this.store.transition(job.correlationId, "CAPTURED", { paymentId: authorized.id });
      await this.store.recordEvent(job.correlationId, {
        event: "RECONCILED",
        state: "CAPTURED",
        razorpayRef: authorized.id,
        payload: { remoteStatus: "captured", via: "payment_poll" },
      });
      return { correlationId: job.correlationId, state: "CAPTURED" };
    }
    await this.store.recordEvent(job.correlationId, {
      event: "PAYMENT_AUTHORIZED",
      state: "AWAITING_PAYMENT",
      razorpayRef: authorized.id,
      payload: { status: authorized.status },
    });
    return this.capture(job, authorized.id, amountPaise);
  }

  private async capture(
    job: ExecutorJob,
    paymentId: string,
    amountPaise: number,
  ): Promise<ExecutionOutcome> {
    // Last boundary before money moves: the mandate must still be alive at capture time,
    // not just at verify time.
    if (!(await this.mandateUnexpired(job.correlationId))) {
      return this.fail(job, { reason: "mandate_expired_at_execution_time" });
    }
    const acquired = await this.store.transition(job.correlationId, "CAPTURING", { paymentId });
    if (!acquired) {
      const current = (await this.store.getJob(job.correlationId)) as ExecutorJob;
      return { correlationId: job.correlationId, state: current.state };
    }
    await this.store.recordEvent(job.correlationId, {
      event: "CAPTURE_ATTEMPTED",
      state: "CAPTURING",
      razorpayRef: paymentId,
      payload: { amountPaise },
    });
    try {
      const payment = await this.razorpay.capture(paymentId, { amountPaise });
      const settled = await this.store.transition(job.correlationId, "CAPTURED", { paymentId });
      if (!settled) {
        // Another worker settled this capture first; its evidence row is authoritative.
        const current = (await this.store.getJob(job.correlationId)) as ExecutorJob;
        return { correlationId: job.correlationId, state: current.state };
      }
      await this.store.recordEvent(job.correlationId, {
        event: "CAPTURED",
        state: "CAPTURED",
        razorpayRef: payment.id,
        payload: { status: payment.status },
      });
      return { correlationId: job.correlationId, state: "CAPTURED" };
    } catch (error) {
      await this.store.transition(job.correlationId, "AWAITING_RECONCILIATION", { paymentId });
      await this.store.recordEvent(job.correlationId, {
        event: "CAPTURE_UNKNOWN",
        state: "AWAITING_RECONCILIATION",
        razorpayRef: paymentId,
        payload: { error: String(error) },
      });
      return this.reconcile((await this.store.getJob(job.correlationId)) as ExecutorJob);
    }
  }

  private async reconcile(job: ExecutorJob): Promise<ExecutionOutcome> {
    if (!job.paymentId) {
      return this.fail(job, { reason: "reconciliation_without_payment_id" });
    }
    let payment = null;
    try {
      payment = await this.razorpay.getPayment(job.paymentId);
    } catch {
      return { correlationId: job.correlationId, state: job.state };
    }
    const remote = payment?.status ?? "missing";
    const nextState: ExecutionState =
      remote === "captured" ? "CAPTURED" : remote === "authorized" ? "AWAITING_PAYMENT" : "FAILED";
    const moved = await this.store.transition(job.correlationId, nextState);
    if (!moved) {
      // Another worker reconciled first; its outcome is authoritative.
      const current = (await this.store.getJob(job.correlationId)) as ExecutorJob;
      return { correlationId: job.correlationId, state: current.state };
    }
    await this.store.recordEvent(job.correlationId, {
      event: "RECONCILED",
      state: nextState,
      razorpayRef: job.paymentId,
      payload: { remoteStatus: remote },
    });
    return { correlationId: job.correlationId, state: nextState };
  }

  private async fail(job: ExecutorJob, payload: Record<string, unknown>): Promise<ExecutionOutcome> {
    await this.store.transition(job.correlationId, "FAILED");
    await this.store.recordEvent(job.correlationId, {
      event: "FAILED",
      state: "FAILED",
      razorpayRef: job.orderId,
      payload,
    });
    return { correlationId: job.correlationId, state: "FAILED" };
  }

  private async loadAllowDecision(
    correlationId: string,
  ): Promise<{ mandateId: string; proposal: Proposal } | null> {
    const result = await this.pool.query(
      `SELECT mandate_id, proposal FROM mandate_decisions
       WHERE correlation_id = $1 AND decision = 'ALLOW'`,
      [correlationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const parsed = proposalSchema.safeParse(row.proposal);
    if (!parsed.success) return null;
    return { mandateId: row.mandate_id as string, proposal: parsed.data };
  }

  private async proposalAmount(correlationId: string): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT proposal FROM mandate_decisions WHERE correlation_id = $1 AND decision = 'ALLOW'`,
      [correlationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const parsed = proposalSchema.safeParse(row.proposal);
    return parsed.success ? parsed.data.amountPaise : null;
  }

  private async gatePermitsStart(correlationId: string): Promise<boolean> {
    if (await this.store.getJob(correlationId)) return true;
    return (await this.gate.clearanceFor(correlationId)) !== "blocked";
  }

  private async mandateUnexpired(correlationId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT m.payload FROM mandates m
       JOIN mandate_decisions d ON d.mandate_id = m.id
       WHERE d.correlation_id = $1`,
      [correlationId],
    );
    const row = result.rows[0];
    if (!row) return false;
    const parsed = mandatePayloadSchema.safeParse(row.payload);
    if (!parsed.success) return false;
    return new Date(parsed.data.expiresAt).getTime() > Date.now();
  }
}
