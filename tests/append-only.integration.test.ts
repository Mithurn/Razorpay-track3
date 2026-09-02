import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";

// The ledger's immutability is a database grant, not an application promise. These tests connect
// as the app role and assert the database itself refuses to rewrite history.

const appUrl = process.env.DATABASE_URL;
const adminUrl = process.env.ADMIN_DATABASE_URL;

describe.runIf(appUrl && adminUrl)("recovery_events is append-only for the app role", () => {
  let app: Db;
  let admin: Db;
  let caseId: string;

  beforeAll(async () => {
    app = createPool(appUrl!);
    admin = createPool(adminUrl!);

    caseId = randomUUID();
    await new PostgresCaseRepository(admin).create({
      id: caseId,
      runId: null,
      merchantRef: "merch_append_only",
      customerRef: "cust_append_only",
      originalPaymentId: null,
      amountPaise: 149900,
      currency: "INR",
      failureCode: "BAD_REQUEST_ERROR",
      failureReason: "card_declined",
      failedAt: new Date().toISOString(),
      customerHistory: [],
    });
    await new PostgresEventLog(app).append({
      caseId,
      type: "CASE_CREATED",
      payload: { seededBy: "append-only test" },
    });
  });

  afterAll(async () => {
    await admin.query("DELETE FROM recovery_events WHERE case_id = $1", [caseId]);
    await admin.query("DELETE FROM recovery_cases WHERE id = $1", [caseId]);
    await Promise.all([app.end(), admin.end()]);
  });

  it("connects as recovery_app, not as the owner", async () => {
    const { rows } = await app.query("SELECT current_user");
    expect(rows[0].current_user).toBe("recovery_app");
  });

  it("allows INSERT and SELECT", async () => {
    const events = await new PostgresEventLog(app).forCase(caseId);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("CASE_CREATED");
  });

  it("refuses UPDATE on recovery_events", async () => {
    await expect(
      app.query("UPDATE recovery_events SET type = 'CASE_RESOLVED' WHERE case_id = $1", [caseId]),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses DELETE on recovery_events", async () => {
    await expect(app.query("DELETE FROM recovery_events WHERE case_id = $1", [caseId])).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("refuses UPDATE and DELETE on razorpay_webhooks", async () => {
    await expect(app.query("UPDATE razorpay_webhooks SET event = 'x'")).rejects.toThrow(/permission denied/i);
    await expect(app.query("DELETE FROM razorpay_webhooks")).rejects.toThrow(/permission denied/i);
  });

  it("still allows the mutable tables to move forward", async () => {
    const repo = new PostgresCaseRepository(app);
    expect(await repo.moveLane(caseId, "INCOMING", "DIAGNOSING")).toBe(true);
    expect(await repo.moveLane(caseId, "INCOMING", "DIAGNOSING")).toBe(false);
  });
});
