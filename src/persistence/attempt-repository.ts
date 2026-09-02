import { randomUUID } from "node:crypto";
import type { AttemptRepository } from "../domain/ports.js";
import type { Attempt, AttemptRequest, AttemptStatus } from "../domain/attempt.js";
import type { RecoveryAction } from "../domain/recovery-action.js";
import type { Db } from "./pool.js";

const COLUMNS = `id, case_id, attempt_no, action, idempotency_key, razorpay_ref,
  settled_payment_id, outcome, outcome_detail, recovered_paise, created_at`;

type Row = Record<string, unknown>;

function toAttempt(row: Row): Attempt {
  return {
    id: row.id as string,
    caseId: row.case_id as string,
    attemptNo: row.attempt_no as number,
    action: row.action as RecoveryAction["kind"],
    idempotencyKey: row.idempotency_key as string,
    razorpayRef: (row.razorpay_ref as string | null) ?? null,
    settledPaymentId: (row.settled_payment_id as string | null) ?? null,
    status: row.outcome as AttemptStatus,
    detail: (row.outcome_detail as string | null) ?? null,
    recoveredPaise: row.recovered_paise as number,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export class PostgresAttemptRepository implements AttemptRepository {
  constructor(private readonly db: Db) {}

  async claim(request: AttemptRequest, idempotencyKey: string): Promise<{ attempt: Attempt; created: boolean }> {
    const { rows } = await this.db.query(
      `INSERT INTO recovery_attempts
         (id, case_id, attempt_no, root_cause, action, agent_reasoning, scheduled_for,
          idempotency_key, clamped, clamp_reason, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        request.caseId,
        request.attemptNo,
        request.rootCause,
        request.action.kind,
        request.reasoning,
        request.scheduledFor,
        idempotencyKey,
        request.clamp !== null,
        request.clamp?.reason ?? null,
        request.createdAt,
      ],
    );
    if (rows.length) return { attempt: toAttempt(rows[0] as Row), created: true };

    const existing = await this.byIdempotencyKey(idempotencyKey);
    if (!existing) throw new Error(`claim raced and lost for ${idempotencyKey} but no row is present`);
    return { attempt: existing, created: false };
  }

  private async byIdempotencyKey(key: string): Promise<Attempt | null> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_attempts WHERE idempotency_key = $1`,
      [key],
    );
    return rows.length ? toAttempt(rows[0] as Row) : null;
  }

  async byId(id: string): Promise<Attempt | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM recovery_attempts WHERE id = $1`, [id]);
    return rows.length ? toAttempt(rows[0] as Row) : null;
  }

  async byRazorpayRef(ref: string): Promise<Attempt | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM recovery_attempts WHERE razorpay_ref = $1`, [ref]);
    return rows.length ? toAttempt(rows[0] as Row) : null;
  }

  async byCaseAndNo(caseId: string, attemptNo: number): Promise<Attempt | null> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_attempts WHERE case_id = $1 AND attempt_no = $2`,
      [caseId, attemptNo],
    );
    return rows.length ? toAttempt(rows[0] as Row) : null;
  }

  async listByCase(caseId: string): Promise<Attempt[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_attempts WHERE case_id = $1 ORDER BY attempt_no`,
      [caseId],
    );
    return rows.map((r) => toAttempt(r as Row));
  }

  async recordRazorpayRef(id: string, ref: string): Promise<void> {
    await this.db.query("UPDATE recovery_attempts SET razorpay_ref = $2 WHERE id = $1", [id, ref]);
  }

  // A RECOVERED attempt is a real credit that already landed; nothing may demote it back to an
  // in-flight status, or a later re-settle can re-arm settleRecovered and double-credit the case.
  async resolve(
    id: string,
    patch: { status: Exclude<AttemptStatus, "RECOVERED">; detail?: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE recovery_attempts
         SET outcome = $2,
             outcome_detail = COALESCE($3, outcome_detail),
             resolved_at = CASE WHEN $2 IN ('PENDING','AWAITING_RECONCILIATION') THEN resolved_at ELSE now() END
       WHERE id = $1 AND outcome <> 'RECOVERED'`,
      [id, patch.status, patch.detail ?? null],
    );
  }

  // Touches two tables on purpose: settling the attempt and crediting the case must be one
  // atomic step, or a crash between them leaves the ledger wrong. The guard is keyed to
  // settled_payment_id rather than outcome, so even a hypothetical status demotion elsewhere
  // can't re-arm a credit that already has a real payment id behind it.
  async settleRecovered(id: string, capturedPaise: number, paymentId: string): Promise<boolean> {
    if (!Number.isInteger(capturedPaise) || capturedPaise <= 0) {
      throw new Error(`settleRecovered needs a positive integer paise amount, got ${capturedPaise}`);
    }
    const { rows } = await this.db.query(
      `WITH settled AS (
         UPDATE recovery_attempts
            SET outcome = 'RECOVERED', settled_payment_id = $3, recovered_paise = $2, resolved_at = now()
          WHERE id = $1 AND settled_payment_id IS NULL
          RETURNING case_id
       )
       UPDATE recovery_cases c
          SET recovered_paise = c.recovered_paise + $2, updated_at = now()
         FROM settled
        WHERE c.id = settled.case_id
        RETURNING c.id`,
      [id, capturedPaise, paymentId],
    );
    return rows.length === 1;
  }

  async listUnsettled(): Promise<Attempt[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_attempts
        WHERE outcome IN ('PENDING','AWAITING_RECONCILIATION') ORDER BY created_at`,
    );
    return rows.map((r) => toAttempt(r as Row));
  }
}
