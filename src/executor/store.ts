import type { Pool } from "pg";
import { VALID_FROM, type ExecutionEvent, type ExecutionState } from "../domain/execution.js";

export type ExecutorJob = {
  correlationId: string;
  state: ExecutionState;
  orderId: string | null;
  paymentId: string | null;
  attempt: number;
};

export class ExecutionStore {
  constructor(private readonly pool: Pool) {}

  async createJobIfAllowed(correlationId: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO executor_jobs (correlation_id, state) VALUES ($1, 'PENDING')
       ON CONFLICT (correlation_id) DO NOTHING`,
      [correlationId],
    );
    return result.rowCount === 1;
  }

  async getJob(correlationId: string): Promise<ExecutorJob | null> {
    const result = await this.pool.query(
      `SELECT correlation_id, state, order_id, payment_id, attempt FROM executor_jobs
       WHERE correlation_id = $1`,
      [correlationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      correlationId: row.correlation_id,
      state: row.state as ExecutionState,
      orderId: row.order_id,
      paymentId: row.payment_id,
      attempt: row.attempt,
    };
  }

  async transition(
    correlationId: string,
    to: ExecutionState,
    patch: { orderId?: string; paymentId?: string } = {},
  ): Promise<boolean> {
    const validFrom = VALID_FROM[to];
    const result = await this.pool.query(
      `UPDATE executor_jobs
       SET state = $2,
           order_id = COALESCE($3, order_id),
           payment_id = COALESCE($4, payment_id),
           attempt = attempt + 1,
           updated_at = now()
       WHERE correlation_id = $1 AND state = ANY($5::text[])`,
      [correlationId, to, patch.orderId ?? null, patch.paymentId ?? null, validFrom],
    );
    return result.rowCount === 1;
  }

  async recordEvent(correlationId: string, event: ExecutionEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO execution_events (correlation_id, event, state, razorpay_ref, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [correlationId, event.event, event.state, event.razorpayRef, JSON.stringify(event.payload)],
    );
  }

  async recordWebhookEventId(eventId: string, event: string): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO webhook_events (event_id, event) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, event],
    );
    return result.rowCount === 1;
  }

  async jobsInStates(states: ExecutionState[], olderThanSeconds = 0): Promise<ExecutorJob[]> {
    const result = await this.pool.query(
      `SELECT correlation_id, state, order_id, payment_id, attempt FROM executor_jobs
       WHERE state = ANY($1::text[]) AND updated_at < now() - ($2 || ' seconds')::interval`,
      [states, String(olderThanSeconds)],
    );
    return result.rows.map((row) => ({
      correlationId: row.correlation_id,
      state: row.state as ExecutionState,
      orderId: row.order_id,
      paymentId: row.payment_id,
      attempt: row.attempt,
    }));
  }
}
