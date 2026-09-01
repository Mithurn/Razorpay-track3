import { Pool } from "pg";
import type { DecisionReason, DecisionRecord } from "../domain/mandate.js";

export interface DecisionLedger {
  recordDecision(record: DecisionRecord): Promise<void>;
  recordAllowWithNonce(record: DecisionRecord, mandateId: string, nonce: string): Promise<boolean>;
  getCase(correlationId: string): Promise<DecisionRecord[]>;
  getMandate(mandateId: string): Promise<StoredMandate | null>;
  storeMandate(mandate: StoredMandate): Promise<void>;
}

export type StoredMandate = {
  id: string;
  agentId?: string | null;
  payload: unknown;
  signature: string;
  publicKey: string;
};

export class PostgresLedger implements DecisionLedger {
  constructor(private readonly pool: Pool) {}

  async recordDecision(record: DecisionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO mandate_decisions (correlation_id, mandate_id, agent_id, proposal, decision, reason, checks)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.correlationId,
        record.mandateId,
        record.proposal?.agentId ?? null,
        record.proposal,
        record.decision,
        record.reason,
        JSON.stringify(record.checks),
      ],
    );
  }

  async recordAllowWithNonce(record: DecisionRecord, mandateId: string, nonce: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const nonceResult = await client.query(
        `INSERT INTO consumed_nonces (mandate_id, nonce, correlation_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (mandate_id, nonce) DO NOTHING`,
        [mandateId, nonce, record.correlationId],
      );
      if (nonceResult.rowCount !== 1) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO mandate_decisions (correlation_id, mandate_id, agent_id, proposal, decision, reason, checks)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          record.correlationId,
          record.mandateId,
          record.proposal?.agentId ?? null,
          record.proposal,
          record.decision,
          record.reason,
          JSON.stringify(record.checks),
        ],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getCase(correlationId: string): Promise<DecisionRecord[]> {
    const result = await this.pool.query(
      `SELECT correlation_id, mandate_id, proposal, decision, reason, checks
       FROM mandate_decisions WHERE correlation_id = $1 ORDER BY id`,
      [correlationId],
    );
    return result.rows.map(rowToRecord);
  }

  async getMandate(mandateId: string): Promise<StoredMandate | null> {
    const result = await this.pool.query(
      `SELECT id, payload, signature, public_key FROM mandates WHERE id = $1`,
      [mandateId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      payload: row.payload,
      signature: row.signature,
      publicKey: row.public_key,
    };
  }

  async storeMandate(mandate: StoredMandate): Promise<void> {
    await this.pool.query(
      `INSERT INTO mandates (id, agent_id, payload, signature, public_key) VALUES ($1, $2, $3, $4, $5)`,
      [mandate.id, mandate.agentId ?? null, mandate.payload, mandate.signature, mandate.publicKey],
    );
  }
}

function rowToRecord(row: Record<string, unknown>): DecisionRecord {
  return {
    correlationId: row.correlation_id as string,
    mandateId: (row.mandate_id as string | null) ?? null,
    proposal: (row.proposal as DecisionRecord["proposal"]) ?? null,
    decision: row.decision as DecisionRecord["decision"],
    reason: row.reason as DecisionReason,
    checks: row.checks as DecisionRecord["checks"],
  };
}
