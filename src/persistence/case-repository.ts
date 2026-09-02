import type { CaseRepository, NewCase } from "../domain/ports.js";
import type { Lane, RecoveryCase } from "../domain/case.js";
import { recoveryCase } from "../domain/case.js";
import type { Db } from "./pool.js";

const COLUMNS = `id, run_id, merchant_ref, customer_ref, original_payment_id, amount_paise,
  currency, failure_code, failure_reason, failed_at, customer_history, lane, recovered_paise`;

type Row = Record<string, unknown>;

function toCase(row: Row): RecoveryCase {
  return recoveryCase.parse({
    id: row.id,
    runId: row.run_id ?? null,
    merchantRef: row.merchant_ref,
    customerRef: row.customer_ref,
    originalPaymentId: row.original_payment_id ?? null,
    amountPaise: row.amount_paise,
    currency: row.currency,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    failedAt: (row.failed_at as Date).toISOString(),
    customerHistory: row.customer_history,
    lane: row.lane,
    recoveredPaise: row.recovered_paise,
  });
}

export class PostgresCaseRepository implements CaseRepository {
  constructor(private readonly db: Db) {}

  async create(newCase: NewCase): Promise<RecoveryCase> {
    const { rows } = await this.db.query(
      `INSERT INTO recovery_cases
         (id, run_id, merchant_ref, customer_ref, original_payment_id, amount_paise, currency,
          failure_code, failure_reason, failed_at, customer_history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${COLUMNS}`,
      [
        newCase.id,
        newCase.runId,
        newCase.merchantRef,
        newCase.customerRef,
        newCase.originalPaymentId,
        newCase.amountPaise,
        newCase.currency,
        newCase.failureCode,
        newCase.failureReason,
        newCase.failedAt,
        JSON.stringify(newCase.customerHistory),
      ],
    );
    return toCase(rows[0] as Row);
  }

  async byId(id: string): Promise<RecoveryCase | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM recovery_cases WHERE id = $1`, [id]);
    return rows.length ? toCase(rows[0] as Row) : null;
  }

  async listByRun(runId: string): Promise<RecoveryCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_cases WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    );
    return rows.map((r) => toCase(r as Row));
  }

  async moveLane(id: string, from: Lane, to: Lane): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "UPDATE recovery_cases SET lane = $3, updated_at = now() WHERE id = $1 AND lane = $2",
      [id, from, to],
    );
    return rowCount === 1;
  }
}
