import type { CaseRepository, NewCase, RoomMetrics, SimilarCaseSummary } from "../domain/ports.js";
import type { Lane, RecoveryCase } from "../domain/case.js";
import { recoveryCase, TERMINAL_LANES } from "../domain/case.js";
import { simulatedPaymentIdLikePatterns } from "../domain/simulated-payment.js";
import type { Db } from "./pool.js";

const COLUMNS = `id, run_id, merchant_ref, customer_ref, original_payment_id, amount_paise,
  currency, failure_code, failure_reason, failed_at, method, instrument, customer_history, lane,
  recovered_paise`;

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
    method: (row.method as string | null) ?? null,
    instrument: (row.instrument as Record<string, string> | null) ?? null,
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
          failure_code, failure_reason, failed_at, method, instrument, customer_history, ground_truth)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
        newCase.method ?? null,
        newCase.instrument ? JSON.stringify(newCase.instrument) : null,
        JSON.stringify(newCase.customerHistory),
        newCase.groundTruth ? JSON.stringify(newCase.groundTruth) : null,
      ],
    );
    return toCase(rows[0] as Row);
  }

  async byId(id: string): Promise<RecoveryCase | null> {
    const { rows } = await this.db.query(`SELECT ${COLUMNS} FROM recovery_cases WHERE id = $1`, [id]);
    return rows.length ? toCase(rows[0] as Row) : null;
  }

  async byOriginalPaymentId(paymentId: string): Promise<RecoveryCase | null> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_cases WHERE original_payment_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [paymentId],
    );
    return rows.length ? toCase(rows[0] as Row) : null;
  }

  async listByRun(runId: string): Promise<RecoveryCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_cases WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    );
    return rows.map((r) => toCase(r as Row));
  }

  async listLive(): Promise<RecoveryCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_cases WHERE run_id IS NULL ORDER BY created_at DESC LIMIT 200`,
    );
    return rows.map((r) => toCase(r as Row));
  }

  async listByLane(lane: Lane): Promise<RecoveryCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_cases WHERE run_id IS NULL AND lane = $1 ORDER BY updated_at DESC`,
      [lane],
    );
    return rows.map((r) => toCase(r as Row));
  }

  async listStaleInLane(lane: Lane, olderThan: Date): Promise<RecoveryCase[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM recovery_cases
        WHERE run_id IS NULL AND lane = $1 AND updated_at < $2
        ORDER BY updated_at`,
      [lane, olderThan],
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

  async metrics(): Promise<RoomMetrics> {
    const [byLane, settlement] = await Promise.all([
      this.db.query(
        `SELECT lane,
                count(*)::bigint AS n,
                coalesce(sum(amount_paise), 0)::bigint AS amount,
                coalesce(sum(recovered_paise), 0)::bigint AS recovered
           FROM recovery_cases
          WHERE run_id IS NULL
          GROUP BY lane`,
      ),
      // isSimulatedPaymentId's own patterns, so this split can never drift from the shared predicate.
      this.db.query(
        `SELECT
           coalesce(sum(a.recovered_paise) FILTER (
             WHERE a.settled_payment_id IS NOT NULL
               AND NOT (a.settled_payment_id LIKE ANY ($1::text[]))
           ), 0)::bigint AS live,
           coalesce(sum(a.recovered_paise) FILTER (
             WHERE a.settled_payment_id LIKE ANY ($1::text[])
           ), 0)::bigint AS simulated
         FROM recovery_attempts a
         JOIN recovery_cases c ON c.id = a.case_id
        WHERE c.run_id IS NULL AND a.outcome = 'RECOVERED'`,
        [simulatedPaymentIdLikePatterns()],
      ),
    ]);

    const metrics: RoomMetrics = {
      recoveredPaise: 0,
      recoveredLivePaise: 0,
      recoveredSimulatedPaise: 0,
      exposurePaise: 0,
      liveCases: 0,
      byLane: {},
    };
    for (const row of byLane.rows as { lane: Lane; n: number; amount: number; recovered: number }[]) {
      metrics.byLane[row.lane] = row.n;
      metrics.liveCases += row.n;
      metrics.recoveredPaise += row.recovered;
      if (!TERMINAL_LANES.includes(row.lane)) metrics.exposurePaise += row.amount;
    }
    const split = settlement.rows[0] as { live: number; simulated: number } | undefined;
    metrics.recoveredLivePaise = split?.live ?? 0;
    metrics.recoveredSimulatedPaise = split?.simulated ?? 0;
    return metrics;
  }

  async similarResolved(
    failureReason: string,
    opts: { method: string | null; beforeFailedAt: string; runId: string | null; limit: number },
  ): Promise<SimilarCaseSummary[]> {
    const { rows } = await this.db.query(
      `SELECT c.failure_reason AS "failureReason",
              a.action,
              a.outcome,
              CASE WHEN a.resolved_at IS NULL
                   THEN NULL
                   ELSE EXTRACT(EPOCH FROM (a.resolved_at - c.failed_at)) / 3600
              END AS "hoursToResolution"
       FROM recovery_cases c
       JOIN recovery_attempts a ON a.case_id = c.id AND a.outcome IN ('RECOVERED', 'FAILED')
       WHERE c.failure_reason = $1
         AND c.lane = 'RECOVERED'
         AND c.run_id IS NOT DISTINCT FROM $2
         AND c.failed_at < $3::timestamptz
         AND ($4::text IS NULL OR c.method = $4)
       ORDER BY c.failed_at DESC, a.attempt_no DESC
       LIMIT $5`,
      [failureReason, opts.runId, opts.beforeFailedAt, opts.method, opts.limit],
    );
    return rows.map((row) => ({
      failureReason: row.failureReason,
      action: row.action,
      outcome: row.outcome,
      hoursToResolution: row.hoursToResolution === null ? null : Number(row.hoursToResolution),
    }));
  }
}
