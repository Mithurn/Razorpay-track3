import Fastify from "fastify";
import { loadConfig } from "./config.js";
import { createPool } from "./persistence/pool.js";
import { PostgresCaseRepository } from "./persistence/case-repository.js";
import { PostgresAttemptRepository } from "./persistence/attempt-repository.js";
import { PostgresEventLog } from "./persistence/event-log.js";
import { PostgresWebhookInbox } from "./persistence/webhook-inbox.js";
import { RunRepository } from "./persistence/run-repository.js";
import { RazorpayClient } from "./execution/razorpay-client.js";
import { RazorpayOutcomeResolver } from "./execution/razorpay-outcome-resolver.js";
import { AttemptExecutor } from "./execution/attempt-executor.js";
import { WebhookHandler } from "./execution/webhook-handler.js";
import { RecoveryPipeline, agentRunnerFor } from "./worker/pipeline.js";
import { openRouterModel } from "./agent/model.js";
import { checkModelHealth } from "./agent/model-health.js";
import { redisConnection, recoveryQueue, recoveryWorker } from "./worker/queue.js";
import { makeProcessor } from "./worker/recovery-worker.js";
import { startReconcileSweep } from "./worker/reconcile-sweep.js";
import { systemClock } from "./domain/attempt.js";
import { CaseEventBus } from "./api/event-bus.js";
import { registerRoutes } from "./api/routes.js";

// Composition root. Every dependency is wired here and nowhere else.

const config = loadConfig();

const pool = createPool(config.DATABASE_URL);
const cases = new PostgresCaseRepository(pool);
const attempts = new PostgresAttemptRepository(pool);
const events = new PostgresEventLog(pool);
const webhooks = new PostgresWebhookInbox(pool);
const runs = new RunRepository(pool);
const bus = new CaseEventBus();

const razorpay = new RazorpayClient({
  keyId: config.RAZORPAY_KEY_ID,
  keySecret: config.RAZORPAY_KEY_SECRET,
  webhookSecret: config.RAZORPAY_WEBHOOK_SECRET,
});
const outcomeResolver = new RazorpayOutcomeResolver(razorpay);
const executor = new AttemptExecutor(attempts, events, razorpay, outcomeResolver);

const pipeline = new RecoveryPipeline({
  cases,
  attempts,
  events,
  gateway: razorpay,
  outcomeResolver,
  clock: systemClock,
  runAgent: agentRunnerFor({
    model: openRouterModel(config.OPENROUTER_API_KEY, config.AGENT_MODEL),
    stepBudget: config.AGENT_STEP_BUDGET,
    deadlineMs: config.AGENT_TIMEOUT_MS,
  }),
});

const connection = redisConnection(config.REDIS_URL);
const queue = recoveryQueue(connection);
const worker = recoveryWorker(connection, makeProcessor(pipeline, queue, bus));
const sweep = startReconcileSweep(attempts, cases, queue);

const webhookHandler = new WebhookHandler(razorpay, webhooks, attempts, cases, events, executor);

const app = Fastify({ logger: true });
// Keep the raw JSON bytes on the request so the Razorpay webhook HMAC verifies against exactly
// what was sent, while req.body stays the ordinary parsed object for every other route.
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  (req as { rawBody?: string }).rawBody = body as string;
  try {
    done(null, body === "" ? undefined : JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
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
  modelHealth: () => checkModelHealth(config.OPENROUTER_API_KEY, config.AGENT_MODEL),
});

await app.listen({ port: config.PORT, host: "0.0.0.0" });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sweep.stop();
    void Promise.allSettled([app.close(), worker.close(), queue.close(), pool.end()]).then(() => process.exit(0));
  });
}
