import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { RunRepository } from "../src/persistence/run-repository.js";
import { RecoveryPipeline, type AgentRunner } from "../src/worker/pipeline.js";
import { runRecoveryAgent } from "../src/agent/recovery-agent.js";
import { isRiskHold, isHardDecline } from "../src/domain/case.js";
import { resolveModel } from "../src/agent/model.js";
import { createBudget, guardModel } from "../src/agent/budget.js";
import { RazorpayClient } from "../src/execution/razorpay-client.js";
import { generateCorpus, type CorpusCase, type GroundTruth } from "./corpus.js";
import { GroundTruthResolver } from "./ground-truth-resolver.js";
import { BenchGateway } from "./bench-gateway.js";
import { fixedScheduleRunner } from "./fixed-arm.js";
import { rulesRunner } from "./rules-arm.js";
import { recordingRunner, replayRunner } from "./mock-agent.js";
import { scoreArm, exceptionList, formatReport, type CaseRecord, type StepDistribution, type GateCounters } from "./metrics.js";
import { LoggingNotifier } from "../src/execution/notifier.js";
import { readFileSync, existsSync } from "node:fs";
import { MAX_AGENT_TURNS_PER_CASE, BENCH_CONCURRENCY } from "./constants.js";

type Arm = "agent" | "fixed" | "rules";
const ALL_ARMS: Arm[] = ["agent", "fixed", "rules"];

const { values } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    size: { type: "string", default: "120" },
    seed: { type: "string", default: "42" },
    arm: { type: "string" },
    "cap-usd": { type: "string", default: "0.30" },
    "blind-reason": { type: "boolean", default: false },
  },
});

const size = Number(values.size);
const seed = Number(values.seed);
// Model in the path, not just seed/size: a bare seed+size cache silently replayed stale turns
// after the corpus and prompt changed underneath it — recordingRunner reuses any existing key
// regardless of what produced it, so a same-shaped rerun looked like 0 model calls and a real
// result, when nothing had actually run. Also what makes a same-corpus model sweep possible: each
// model gets its own file instead of overwriting the last one's recording.
const modelSlug = (process.env.AGENT_MODEL ?? "minimax/minimax-m3:free").replace(/[^a-zA-Z0-9._-]/g, "_");
const blindReason = values["blind-reason"] === true;
// A blinded corpus produces different agent turns than the labeled one — its own cache file, or
// a --blind-reason run would silently replay (or overwrite) the labeled run's recording.
const cachePath = `bench/.cache/agent-turns-seed${seed}-n${size}-${modelSlug}${blindReason ? "-blind" : ""}.json`;

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);
  const cases = new PostgresCaseRepository(pool);
  const attempts = new PostgresAttemptRepository(pool);
  const events = new PostgresEventLog(pool);
  const runs = new RunRepository(pool);

  // A --mock run replays recorded agent turns and never calls check_bank_downtime live, so it
  // needs no Razorpay credentials at all — skip the call rather than relying on a placeholder
  // key to fail gracefully against a real endpoint.
  const downtimes = values.mock
    ? []
    : await new RazorpayClient({
        keyId: config.RAZORPAY_KEY_ID,
        keySecret: config.RAZORPAY_KEY_SECRET,
        webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
      })
        .listDowntimes()
        .catch(() => []);
  console.error(`loaded ${downtimes.length} live downtimes from Razorpay`);

  const armsToRun: Arm[] = values.arm ? [values.arm as Arm] : ALL_ARMS;
  const budget = createBudget(Number(values["cap-usd"]), {
    usdPerMInput: config.AGENT_USD_PER_M_INPUT,
    usdPerMOutput: config.AGENT_USD_PER_M_OUTPUT,
  });

  const agentRunner: AgentRunner = !armsToRun.includes("agent")
    ? fixedScheduleRunner
    : values.mock
      ? replayRunner(cachePath)
      : recordingRunner(
          (deps, events) =>
            runRecoveryAgent(
              deps,
              {
                model: guardModel(
                  resolveModel(config.AGENT_MODEL, {
                    openRouterApiKey: config.OPENROUTER_API_KEY,
                    googleApiKey: config.GOOGLE_GENERATIVE_AI_API_KEY,
                  }),
                  budget,
                ),
                stepBudget: config.AGENT_STEP_BUDGET,
                deadlineMs: config.AGENT_TIMEOUT_MS,
              },
              events,
            ),
          cachePath,
        );
  const results: Record<string, CaseRecord[]> = {};

  let agentRunId: string | null = null;
  for (const arm of armsToRun) {
    const runId = randomUUID();
    if (arm === "agent") agentRunId = runId;
    await runs.create(runId, arm, `${arm} seed=${seed} n=${size}`, { seed, size, mock: values.mock });
    const corpus = generateCorpus({ runId, size, seed, blindReason });
    const truth = new Map<string, GroundTruth>(corpus.map((c) => [c.id, c.groundTruth]));

    for (const c of corpus) await cases.create(c);

    const runner = arm === "fixed" ? fixedScheduleRunner : arm === "rules" ? rulesRunner : agentRunner;
    const started = Date.now();

    const timing = await runArm(corpus, { cases, attempts, events, runner, downtimes, truth });
    const records = await collect(corpus, cases, attempts, truth, timing);
    console.error(
      `${arm}: ${corpus.length} cases in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        (arm === "agent" && !values.mock
          ? ` · ${budget.calls} model calls, ${budget.inputTokens}/${budget.outputTokens} tokens, $${budget.usdUsed.toFixed(4)}`
          : ""),
    );
    results[arm] = records;
    await runs.finish(runId, { ...scoreArm(arm, records) });
  }

  const agentM = results.agent ? scoreArm("agent", results.agent) : blank("agent");
  const fixedM = results.fixed ? scoreArm("fixed", results.fixed) : blank("fixed");
  const rulesM = results.rules ? scoreArm("rules", results.rules) : undefined;
  // The exception section names the arm it came from — falling back to another arm's records
  // would silently change what the list means.
  const exceptionArm = results.agent ? "agent" : results.fixed ? "fixed" : null;
  const exceptions = exceptionArm ? exceptionList(results[exceptionArm as "agent" | "fixed"]!) : [];
  const steps = armsToRun.includes("agent") ? stepDistFromCache(cachePath) : undefined;
  const gates = agentRunId ? await gateCountersFromDb(pool, agentRunId) : undefined;
  console.log(formatReport(agentM, fixedM, exceptions, rulesM, exceptionArm ?? undefined, budget, steps, gates));

  await pool.end();
}

type ArmDeps = {
  cases: PostgresCaseRepository;
  attempts: PostgresAttemptRepository;
  events: PostgresEventLog;
  runner: AgentRunner;
  downtimes: Awaited<ReturnType<RazorpayClient["listDowntimes"]>>;
  truth: Map<string, GroundTruth>;
};

async function runArm(corpus: CorpusCase[], deps: ArmDeps): Promise<Map<string, number | null>> {
  const timing = new Map<string, number | null>();
  for (let i = 0; i < corpus.length; i += BENCH_CONCURRENCY) {
    const batch = corpus.slice(i, i + BENCH_CONCURRENCY);
    const hours = await Promise.all(batch.map((c) => driveCase(c, deps)));
    batch.forEach((c, j) => timing.set(c.id, hours[j]!));
  }
  return timing;
}

async function driveCase(c: CorpusCase, deps: ArmDeps): Promise<number | null> {
  const epoch = Date.parse(c.failedAt);
  const clock = { current: new Date(epoch) };
  const resolver = new GroundTruthResolver(deps.truth, { now: () => clock.current }, epoch);
  const pipeline = new RecoveryPipeline({
    cases: deps.cases,
    attempts: deps.attempts,
    events: deps.events,
    gateway: new BenchGateway(deps.downtimes),
    outcomeResolver: resolver,
    notifier: new LoggingNotifier(deps.events),
    clock: { now: () => clock.current },
    riskHoldForCase: isRiskHold,
    hardDeclineForCase: isHardDecline,
    similarCases: (kase, query) =>
      deps.cases.similarResolved(kase.failureReason, {
        method: query.method ?? null,
        beforeFailedAt: kase.failedAt,
        runId: kase.runId,
        limit: query.limit ?? 8,
      }),
    runAgent: deps.runner,
  });

  for (let turn = 0; turn < MAX_AGENT_TURNS_PER_CASE; turn++) {
    const outcome = await pipeline.advance(c.id);
    if (outcome.kind === "resolved") {
      return outcome.lane === "RECOVERED" ? resolver.recoveredAtHour(c.id) : null;
    }
    if (outcome.kind === "not_claimed") return null;
    clock.current = new Date(clock.current.getTime() + outcome.delayMs);
  }
  return null;
}

async function collect(
  corpus: CorpusCase[],
  cases: PostgresCaseRepository,
  attempts: PostgresAttemptRepository,
  truth: Map<string, GroundTruth>,
  timing: Map<string, number | null>,
): Promise<CaseRecord[]> {
  return Promise.all(
    corpus.map(async (c) => ({
      kase: (await cases.byId(c.id))!,
      attempts: await attempts.listByCase(c.id),
      groundTruth: truth.get(c.id)!,
      simHoursToResolution: timing.get(c.id) ?? null,
    })),
  );
}

function blank(arm: string) {
  return scoreArm(arm, []);
}

async function gateCountersFromDb(db: ReturnType<typeof createPool>, runId: string): Promise<GateCounters> {
  const { rows } = await db.query<{ outcome: string; rule: string | null; count: string }>(
    `SELECT
       re.payload->>'outcome' AS outcome,
       re.payload->>'rule'    AS rule,
       COUNT(*)::text         AS count
     FROM recovery_events re
     JOIN recovery_cases rc ON rc.id = re.case_id
     WHERE rc.run_id = $1 AND re.type = 'GATE_APPLIED'
     GROUP BY outcome, rule
     ORDER BY COUNT(*) DESC`,
    [runId],
  );
  return {
    total: rows.reduce((s, r) => s + Number(r.count), 0),
    byOutcome: rows.map((r) => ({ outcome: r.outcome, rule: r.rule, count: Number(r.count) })),
  };
}

function stepDistFromCache(path: string): StepDistribution | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const toolCalls: number[] = [];
    let degraded = 0;
    for (const entry of Object.values(raw)) {
      const e = entry as Record<string, unknown>;
      const p = ("proposal" in e ? e.proposal : e) as { toolCalls?: number; degraded?: boolean };
      toolCalls.push(p.toolCalls ?? 0);
      if (p.degraded) degraded++;
    }
    if (toolCalls.length === 0) return undefined;
    toolCalls.sort((a, b) => a - b);
    const n = toolCalls.length;
    return {
      turns: n,
      degraded,
      p50: toolCalls[Math.floor(n * 0.5)]!,
      p95: toolCalls[Math.floor(n * 0.95)]!,
      max: toolCalls[n - 1]!,
    };
  } catch {
    return undefined;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
