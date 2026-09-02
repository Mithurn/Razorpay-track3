import { loadConfig } from "../src/config.js";
import { createPool } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { RunRepository } from "../src/persistence/run-repository.js";
import { RecoveryPipeline } from "../src/worker/pipeline.js";
import { RazorpayClient } from "../src/execution/razorpay-client.js";
import { generateCorpus, type GroundTruth } from "./corpus.js";
import { GroundTruthResolver } from "./ground-truth-resolver.js";
import { BenchGateway } from "./bench-gateway.js";
import { fixedScheduleRunner } from "./fixed-arm.js";
import { replayRunner } from "./mock-agent.js";
import { scoreArm, type CaseRecord } from "./metrics.js";
import { randomUUID } from "node:crypto";
import { isRiskHold } from "../src/domain/case.js";

// Populates the live Recovery Room from recorded agent turns (free, no model calls). Leaves ~60
// real cases in their final lanes with full event tapes so the UI opens onto a working room,
// and writes an agent-vs-fixed run pair for the scoreboard.

const SEED = 42;
const SIZE = 60;
const cachePath = `bench/.cache/agent-turns-seed${SEED}-n${SIZE}.json`;

async function main(): Promise<void> {
  const config = loadConfig();
  // Seeding truncates and back-dates rows, which the append-only app role cannot do.
  const pool = createPool(process.env.ADMIN_DATABASE_URL ?? config.DATABASE_URL);
  const cases = new PostgresCaseRepository(pool);
  const attempts = new PostgresAttemptRepository(pool);
  const events = new PostgresEventLog(pool);
  const runs = new RunRepository(pool);

  await pool.query("DELETE FROM recovery_events");
  await pool.query("DELETE FROM recovery_attempts");
  await pool.query("DELETE FROM recovery_cases");
  await pool.query("DELETE FROM recovery_runs");

  const razorpay = new RazorpayClient({
    keyId: config.RAZORPAY_KEY_ID,
    keySecret: config.RAZORPAY_KEY_SECRET,
    webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
  });
  const downtimes = await razorpay.listDowntimes().catch(() => []);

  const agentRunner = replayRunner(cachePath);

  for (const arm of ["agent", "fixed"] as const) {
    const runId = randomUUID();
    await runs.create(runId, arm, `${arm} · room seed`, { seed: SEED, size: SIZE });
    const corpus = generateCorpus({ runId: arm === "agent" ? null : runId, size: SIZE, seed: SEED });
    const truth = new Map<string, GroundTruth>(corpus.map((c) => [c.id, c.groundTruth]));
    const runner = arm === "agent" ? agentRunner : fixedScheduleRunner;

    const records: CaseRecord[] = [];
    for (const c of corpus) {
      await cases.create(c);
      const epoch = Date.parse(c.failedAt);
      const clock = { current: new Date(epoch) };
      const resolver = new GroundTruthResolver(truth, { now: () => clock.current }, epoch);
      const pipeline = new RecoveryPipeline({
        cases,
        attempts,
        events,
        gateway: new BenchGateway(downtimes),
        outcomeResolver: resolver,
        clock: { now: () => clock.current },
        riskHoldForCase: isRiskHold,
        similarCases: (kase, query) =>
          cases.similarResolved(kase.failureReason, {
            method: query.method ?? null,
            beforeFailedAt: kase.failedAt,
            runId: kase.runId,
            limit: query.limit ?? 8,
          }),
        runAgent: runner,
      });
      let simHours: number | null = null;
      for (let turn = 0; turn < 12; turn++) {
        const outcome = await pipeline.advance(c.id);
        if (outcome.kind === "resolved") {
          simHours = outcome.lane === "RECOVERED" ? resolver.recoveredAtHour(c.id) : null;
          break;
        }
        if (outcome.kind === "not_claimed") break;
        clock.current = new Date(clock.current.getTime() + outcome.delayMs);
      }
      records.push({
        kase: (await cases.byId(c.id))!,
        attempts: await attempts.listByCase(c.id),
        groundTruth: truth.get(c.id)!,
        simHoursToResolution: simHours,
      });
    }
    await runs.finish(runId, { ...scoreArm(arm, records) });
    const m = scoreArm(arm, records);
    console.log(`${arm}: ${m.recovered}/${m.cases} recovered, ₹${(m.recoveredPaise / 100).toLocaleString("en-IN")}`);
  }

  // Leave a couple of the agent's live escalations sitting in the queue for the demo, plus one
  // fresh untouched case to run live on camera.
  await cases.create({
    id: randomUUID(),
    runId: null,
    merchantRef: "acme_subscriptions",
    customerRef: "cust_live_demo",
    originalPaymentId: null,
    amountPaise: 149900,
    currency: "INR",
    failureCode: "BAD_REQUEST_ERROR",
    failureReason: "card_declined",
    failedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
    method: "card",
    instrument: { issuer: downtimes.find((d) => d.method === "card")?.instrument.issuer ?? "BKID" },
    customerHistory: [
      { paidAt: "2026-05-01T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
      { paidAt: "2026-06-02T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
      { paidAt: "2026-07-01T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
      { paidAt: "2026-08-03T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
    ],
  });

  // A second fresh case, deliberately over the ₹5,000 exposure cap: the agent will read a clean
  // 4/4 customer and propose a retry, and the deterministic gate will clamp that to ESCALATE.
  // This is the safety interlock made visible on camera.
  await cases.create({
    id: randomUUID(),
    runId: null,
    merchantRef: "acme_subscriptions",
    customerRef: "cust_over_cap",
    originalPaymentId: null,
    amountPaise: 649900,
    currency: "INR",
    failureCode: "BAD_REQUEST_ERROR",
    failureReason: "card_declined",
    failedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    method: "card",
    instrument: { issuer: "HDFC" },
    customerHistory: [
      { paidAt: "2026-05-04T10:00:00.000Z", amountPaise: 649900, method: "card", status: "captured" },
      { paidAt: "2026-06-04T10:00:00.000Z", amountPaise: 649900, method: "card", status: "captured" },
      { paidAt: "2026-07-04T10:00:00.000Z", amountPaise: 649900, method: "card", status: "captured" },
      { paidAt: "2026-08-04T10:00:00.000Z", amountPaise: 649900, method: "card", status: "captured" },
    ],
  });

  console.log("room seeded — cust_live_demo and cust_over_cap are fresh and ready to run live");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
