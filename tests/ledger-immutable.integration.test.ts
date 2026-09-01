import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const d = process.env.DATABASE_URL ? describe : describe.skip;

if (!process.env.DATABASE_URL) {
  console.log("Skipping ledger immutability tests: DATABASE_URL not set.");
}

d("evidence ledger immutability (app role)", () => {
  let adminPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = new Pool({
      connectionString: process.env.ADMIN_DATABASE_URL ?? "postgres://aegis:aegis_dev@localhost:5433/aegis",
    });
    appPool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it("rejects UPDATE and DELETE on append-only evidence tables", async () => {
    await adminPool.query("TRUNCATE mandate_decisions, execution_events, webhook_events");
    await adminPool.query(
      `INSERT INTO mandate_decisions (correlation_id, decision, reason, checks)
       VALUES ('11111111-1111-4111-8111-111111111111', 'DENY', 'malformed_request', '[]')`,
    );
    await adminPool.query(
      `INSERT INTO execution_events (correlation_id, event, payload)
       VALUES ('11111111-1111-4111-8111-111111111111', 'JOB_CREATED', '{}')`,
    );
    await adminPool.query(
      `INSERT INTO webhook_events (event_id, event) VALUES ('evt_test', 'payment.captured')`,
    );

    await expect(appPool.query(`UPDATE mandate_decisions SET decision = 'ALLOW'`)).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`DELETE FROM mandate_decisions`)).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`UPDATE execution_events SET event = 'TAMPERED'`)).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`DELETE FROM execution_events`)).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`DELETE FROM webhook_events`)).rejects.toThrow(/permission denied/);
    await expect(appPool.query(`UPDATE consumed_nonces SET nonce = 'x'`)).rejects.toThrow(/permission denied/);
  });

  it("still allows the app role to insert and read evidence", async () => {
    const correlationId = "22222222-2222-4222-8222-222222222222";
    await adminPool.query("TRUNCATE mandate_decisions");
    await appPool.query(
      `INSERT INTO mandate_decisions (correlation_id, decision, reason, checks)
       VALUES ($1, 'ALLOW', 'all_checks_passed', '[]')`,
      [correlationId],
    );
    const rows = await appPool.query(
      `SELECT decision FROM mandate_decisions WHERE correlation_id = $1`,
      [correlationId],
    );
    expect(rows.rows).toHaveLength(1);
  });
});
