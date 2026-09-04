import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createPool } from "./persistence/pool.js";
import { PostgresCaseRepository } from "./persistence/case-repository.js";
import { LanePublishingCaseRepository } from "./persistence/lane-publishing-case-repository.js";
import { PostgresAttemptRepository } from "./persistence/attempt-repository.js";
import { PostgresEventLog } from "./persistence/event-log.js";
import { PublishingEventLog } from "./persistence/publishing-event-log.js";
import { verifyAppendOnly } from "./persistence/audit-verify.js";
import { PostgresWebhookInbox } from "./persistence/webhook-inbox.js";
import { RunRepository } from "./persistence/run-repository.js";
import { RazorpayClient } from "./execution/razorpay-client.js";
import { RazorpayOutcomeResolver } from "./execution/razorpay-outcome-resolver.js";
import { AttemptExecutor } from "./execution/attempt-executor.js";
import { LoggingNotifier } from "./execution/notifier.js";
import { WebhookHandler } from "./execution/webhook-handler.js";
import { RecoveryPipeline, agentRunnerFor } from "./worker/pipeline.js";
import { DEFAULT_LIMITS } from "./safety/safety-gate.js";
import { resolveModel } from "./agent/model.js";
import { checkModelHealth } from "./agent/model-health.js";
import { createBudget, guardModel } from "./agent/budget.js";
import { redisConnection, recoveryQueue, recoveryWorker, enqueueRecovery } from "./worker/queue.js";
import { makeProcessor } from "./worker/recovery-worker.js";
import { startReconcileSweep } from "./worker/reconcile-sweep.js";
import { systemClock } from "./domain/attempt.js";
import { isRiskHold, isHardDecline } from "./domain/case.js";
import { CaseEventBus } from "./api/event-bus.js";
import { registerRoutes } from "./api/routes.js";

// Composition root. Every dependency is wired here and nowhere else.

const config = loadConfig();

const pool = createPool(config.DATABASE_URL);
const attempts = new PostgresAttemptRepository(pool);
const webhooks = new PostgresWebhookInbox(pool);
const runs = new RunRepository(pool);
const bus = new CaseEventBus();
// Every appended event is mirrored to the live stream as an `audit` event.
const events = new PublishingEventLog(new PostgresEventLog(pool), bus);
// Every successful lane move is recorded as a CASE_LANE_CHANGED event through the same log, so
// case position is never a bare UPDATE invisible to the audit trail.
const cases = new LanePublishingCaseRepository(new PostgresCaseRepository(pool), events);

const razorpay = new RazorpayClient({
  keyId: config.RAZORPAY_KEY_ID,
  keySecret: config.RAZORPAY_KEY_SECRET,
  webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
});
const outcomeResolver = new RazorpayOutcomeResolver(razorpay);
const notifier = new LoggingNotifier(events);
const executor = new AttemptExecutor(attempts, events, razorpay, outcomeResolver, notifier);

const pipeline = new RecoveryPipeline({
  cases,
  attempts,
  events,
  gateway: razorpay,
  outcomeResolver,
  notifier,
  clock: systemClock,
  riskHoldForCase: isRiskHold,
  hardDeclineForCase: isHardDecline,
  similarCases: (kase, query) =>
    cases.similarResolved(kase.failureReason, {
      method: query.method ?? null,
      beforeFailedAt: kase.failedAt,
      runId: kase.runId,
      limit: query.limit ?? 8,
    }),
  runAgent: agentRunnerFor({
    model: guardModel(
      resolveModel(config.AGENT_MODEL, {
        openRouterApiKey: config.OPENROUTER_API_KEY,
        googleApiKey: config.GOOGLE_GENERATIVE_AI_API_KEY,
      }),
      createBudget(config.AGENT_SESSION_CAP_USD),
    ),
    stepBudget: config.AGENT_STEP_BUDGET,
    deadlineMs: config.AGENT_TIMEOUT_MS,
  }),
});

const connection = redisConnection(config.REDIS_URL);
const queue = recoveryQueue(connection);
const worker = recoveryWorker(connection, makeProcessor(pipeline, queue, bus, events));
const sweep = startReconcileSweep(attempts, cases, queue);

// The queue is bound here, in the composition root — the handler only sees the port.
const enqueuer = { enqueue: (caseId: string) => enqueueRecovery(queue, caseId) };
const webhookHandler = new WebhookHandler(razorpay, webhooks, attempts, cases, events, executor, enqueuer, config.MERCHANT_REF);

const app = Fastify({ logger: true });
// Keep the raw JSON bytes on the request so the Razorpay webhook HMAC verifies against exactly
// what was sent, while req.body stays the ordinary parsed object for every other route.
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body === "" ? undefined : JSON.parse(body as string));
  } catch (err) {
    const parseError = err as Error & { statusCode?: number };
    parseError.statusCode = 400;
    done(parseError, undefined);
  }
});
app.get("/health", async () => ({ status: "ok" }));
await registerRoutes(app, {
  cases,
  attempts,
  events,
  runs,
  queue,
  webhookHandler,
  bus,
  pipeline,
  modelHealth: () =>
    checkModelHealth(
      { openRouterApiKey: config.OPENROUTER_API_KEY, googleApiKey: config.GOOGLE_GENERATIVE_AI_API_KEY },
      config.AGENT_MODEL,
    ),
  verifyAppendOnly: () => verifyAppendOnly(pool),
  runtimeInfo: {
    model: config.AGENT_MODEL,
    deadlineMs: config.AGENT_TIMEOUT_MS,
    stepBudget: config.AGENT_STEP_BUDGET,
    limits: DEFAULT_LIMITS,
    razorpayKeyId: config.RAZORPAY_KEY_ID,
  },
  gateway: razorpay,
  razorpayWebhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
  demoAccessToken: config.DEMO_ACCESS_TOKEN,
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sweep.stop();
    void Promise.allSettled([app.close(), worker.close(), queue.close(), pool.end()]).then(() => process.exit(0));
  });
}
