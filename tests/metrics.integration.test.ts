import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import type { NewCase } from "../src/domain/ports.js";

// The room table is shared with whatever the dev seed has put in it, so these assert the delta
// a known set of inserted cases makes to metrics(), not an absolute total.

const adminUrl = process.env.ADMIN_DATABASE_URL;

const base: Omit<NewCase, "id" | "amountPaise"> = {
  runId: null,
  merchantRef: "merch_metrics_test",
  customerRef: "cust_metrics_test",
  originalPaymentId: null,
  currency: "INR",
  failureCode: "BAD_REQUEST_ERROR",
  failureReason: "card_declined",
  failedAt: new Date().toISOString(),
  customerHistory: [],
};

describe.runIf(adminUrl)("CaseRepository.metrics", () => {
  let db: Db;
  let repo: PostgresCaseRepository;
  const ids: string[] = [];

  beforeAll(async () => {
    db = createPool(adminUrl!);
    repo = new PostgresCaseRepository(db);
  });

  afterAll(async () => {
    if (ids.length) await db.query("DELETE FROM recovery_cases WHERE id = ANY($1::uuid[])", [ids]);
    await db.end();
  });

  it("counts exposure only for live, non-terminal cases and recovered from real captures", async () => {
    const before = await repo.metrics();

    const incoming = randomUUID();
    const escalated = randomUUID();
    const recovered = randomUUID();
    ids.push(incoming, escalated, recovered);

    await repo.create({ ...base, id: incoming, amountPaise: 100_00 });
    await repo.create({ ...base, id: escalated, amountPaise: 200_00 });
    await repo.moveLane(escalated, "INCOMING", "ESCALATED");
    await repo.create({ ...base, id: recovered, amountPaise: 300_00 });
    await repo.moveLane(recovered, "INCOMING", "RECOVERED");
    // settleRecovered is attempt-executor's job; metrics only cares that recovered_paise is
    // summed, so set it directly to isolate this assertion from attempt plumbing.
    await db.query("UPDATE recovery_cases SET recovered_paise = 300_00 WHERE id = $1", [recovered]);

    const after = await repo.metrics();

    // The two non-terminal cases (incoming, escalated) count toward exposure; escalated is a
    // terminal lane and drops out even though it moved money nowhere.
    expect(after.exposurePaise - before.exposurePaise).toBe(100_00);
    expect(after.recoveredPaise - before.recoveredPaise).toBe(300_00);
    expect(after.liveCases - before.liveCases).toBe(3);
    expect((after.byLane.INCOMING ?? 0) - (before.byLane.INCOMING ?? 0)).toBe(1);
    expect((after.byLane.ESCALATED ?? 0) - (before.byLane.ESCALATED ?? 0)).toBe(1);
    expect((after.byLane.RECOVERED ?? 0) - (before.byLane.RECOVERED ?? 0)).toBe(1);
  });

  it("splits recovered_paise into a real Razorpay capture and a simulated settlement, never blended", async () => {
    const before = await repo.metrics();

    const liveCase = randomUUID();
    const simCase = randomUUID();
    ids.push(liveCase, simCase);
    await repo.create({ ...base, id: liveCase, amountPaise: 111_00 });
    await repo.moveLane(liveCase, "INCOMING", "RECOVERED");
    await repo.create({ ...base, id: simCase, amountPaise: 222_00 });
    await repo.moveLane(simCase, "INCOMING", "RECOVERED");

    await db.query(
      `INSERT INTO recovery_attempts
         (id, case_id, attempt_no, root_cause, action, idempotency_key, outcome, settled_payment_id, recovered_paise)
       VALUES ($1, $2, 1, 'soft_decline', 'RETRY_NOW', $3, 'RECOVERED', $4, $5)`,
      [randomUUID(), liveCase, `${liveCase}:1`, "pay_live_metrics_test", 111_00],
    );
    await db.query(
      `INSERT INTO recovery_attempts
         (id, case_id, attempt_no, root_cause, action, idempotency_key, outcome, settled_payment_id, recovered_paise)
       VALUES ($1, $2, 1, 'soft_decline', 'RETRY_NOW', $3, 'RECOVERED', $4, $5)`,
      [randomUUID(), simCase, `${simCase}:1`, `sim_${simCase}`, 222_00],
    );
    await db.query("UPDATE recovery_cases SET recovered_paise = recovered_paise + 111_00 WHERE id = $1", [liveCase]);
    await db.query("UPDATE recovery_cases SET recovered_paise = recovered_paise + 222_00 WHERE id = $1", [simCase]);

    const after = await repo.metrics();

    expect(after.recoveredLivePaise - before.recoveredLivePaise).toBe(111_00);
    expect(after.recoveredSimulatedPaise - before.recoveredSimulatedPaise).toBe(222_00);
    expect(after.recoveredPaise - before.recoveredPaise).toBe(333_00);

    await db.query("DELETE FROM recovery_attempts WHERE case_id = ANY($1::uuid[])", [[liveCase, simCase]]);
  });

  it("excludes bench-run cases (run_id set) from live totals", async () => {
    const runId = randomUUID();
    await db.query(
      "INSERT INTO recovery_runs (id, label, arm, config) VALUES ($1, 'metrics test run', 'agent', '{}')",
      [runId],
    );
    const before = await repo.metrics();

    const benchCase = randomUUID();
    ids.push(benchCase);
    await repo.create({ ...base, id: benchCase, runId, amountPaise: 999_00 });

    const after = await repo.metrics();

    expect(after.exposurePaise).toBe(before.exposurePaise);
    expect(after.liveCases).toBe(before.liveCases);

    // Case row must go before the run row it references, or the FK refuses the delete.
    await db.query("DELETE FROM recovery_cases WHERE id = $1", [benchCase]);
    ids.splice(ids.indexOf(benchCase), 1);
    await db.query("DELETE FROM recovery_runs WHERE id = $1", [runId]);
  });
});
