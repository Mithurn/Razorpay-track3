import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../src/config.js";
import { createPool } from "../src/persistence/pool.js";
import { PostgresCaseRepository } from "../src/persistence/case-repository.js";
import { PostgresAttemptRepository } from "../src/persistence/attempt-repository.js";
import { PostgresEventLog } from "../src/persistence/event-log.js";
import { RunRepository } from "../src/persistence/run-repository.js";
import { RecoveryPipeline, agentRunnerFor, type AgentRunner } from "../src/worker/pipeline.js";
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
import { scoreArm, exceptionList, formatReport, type CaseRecord } from "./metrics.js";
import { LoggingNotifier } from "../src/execution/notifier.js";

const MAX_TURNS = 12;
const CONCURRENCY = 10;

type Arm = "agent" | "fixed" | "rules";
const ALL_ARMS: Arm[] = ["agent", "fixed", "rules"];

const { values } = parseArgs({
  options: {
    mock: { type: "boolean", default: false },
    size: { type: "string", default: "120" },
    seed: { type: "string", default: "42" },
    arm: { type: "string" },
    "cap-usd": { type: "string", default: "0.30" },
  },
});

const size = Number(values.size);
const seed = Number(values.seed);
const cachePath = `bench/.cache/agent-turns-seed${seed}-n${size}.json`;

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
  const budget = createBudget(Number(values["cap-usd"]));

  const agentRunner: AgentRunner = !armsToRun.includes("agent")
    ? fixedScheduleRunner
    : values.mock
      ? replayRunner(cachePath)
      : recordingRunner(
          agentRunnerFor({
            model: guardModel(
              resolveModel(config.AGENT_MODEL, {
                openRouterApiKey: config.OPENROUTER_API_KEY,
                googleApiKey: config.GOOGLE_GENERATIVE_AI_API_KEY,
              }),
              budget,
            ),
            stepBudget: config.AGENT_STEP_BUDGET,
            deadlineMs: config.AGENT_TIMEOUT_MS,
          }),
          cachePath,
        );
  const results: Record<string, CaseRecord[]> = {};

  for (const arm of armsToRun) {
    const runId = randomUUID();
    await runs.create(runId, arm, `${arm} seed=${seed} n=${size}`, { seed, size, mock: values.mock });
    const corpus = generateCorpus({ runId, size, seed });
    const truth = new Map<string, GroundTruth>(corpus.map((c) => [c.id, c.groundTruth]));

    for (const c of corpus) await cases.create(c);

    const runner = arm === "fixed" ? fixedScheduleRunner : arm === "rules" ? rulesRunner : agentRunner;
    const started = Date.now();

    const timing = await runArm(corpus, { cases, attempts, events, runner, downtimes, truth });
    const records = await collect(corpus, cases, attempts, truth, timing);
    console.error(
      `${arm}: ${corpus.length} cases in ${((Date.now() - started) / 1000).toFixed(1)}s` +
        (arm === "agent" && !values.mock ? ` · ${budget.calls} model calls, ~$${budget.estUsd.toFixed(3)} est` : ""),
    );
    results[arm] = records;
    await runs.finish(runId, { ...scoreArm(arm, records) });
  }

  const agentM = results.agent ? scoreArm("agent", results.agent) : blank("agent");
  const fixedM = results.fixed ? scoreArm("fixed", results.fixed) : blank("fixed");
  const rulesM = results.rules ? scoreArm("rules", results.rules) : undefined;
  const exceptions = exceptionList(results.agent ?? results.fixed ?? []);
  console.log(formatReport(agentM, fixedM, exceptions, rulesM));

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
  for (let i = 0; i < corpus.length; i += CONCURRENCY) {
    const batch = corpus.slice(i, i + CONCURRENCY);
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

  for (let turn = 0; turn < MAX_TURNS; turn++) {
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
