import { loadConfig } from "../src/config.js";
import { resolveModel } from "../src/agent/model.js";
import { runRecoveryAgent } from "../src/agent/recovery-agent.js";
import type { AgentDeps } from "../src/agent/tools.js";
import type { RecoveryCase } from "../src/domain/case.js";

// One real agent run against a fabricated case. Proves the multi-turn tool loop survives the
// OpenRouter round-trip before anything depends on it.

const model = process.argv[2] ?? "minimax/minimax-m3:free";
const config = loadConfig();

const kase: RecoveryCase = {
  id: "00000000-0000-4000-8000-000000000001",
  runId: null,
  merchantRef: "acme_subscriptions",
  customerRef: "cust_smoke",
  originalPaymentId: null,
  amountPaise: 149900,
  currency: "INR",
  failureCode: "BAD_REQUEST_ERROR",
  failureReason: "card_declined",
  failedAt: "2026-09-01T10:00:00.000Z",
  method: "card",
  instrument: { issuer: "BKID" },
  customerHistory: [
    { paidAt: "2026-05-01T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
    { paidAt: "2026-06-02T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
    { paidAt: "2026-07-01T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
    { paidAt: "2026-08-03T10:00:00.000Z", amountPaise: 149900, method: "card", status: "captured" },
  ],
  lane: "DIAGNOSING",
  recoveredPaise: 0,
};

const deps: AgentDeps = {
  kase,
  method: "card",
  instrumentHint: "BKID",
  gateway: {
    listDowntimes: async () => [
      {
        id: "down_smoke",
        method: "card",
        severity: "high",
        status: "started",
        instrument: { issuer: "BKID" },
        begin: "2026-09-01T09:20:00.000Z",
        end: null,
      },
    ],
  },
  priorAttempts: [],
  similarCases: async () => [
    { failureReason: "card_declined", action: "RETRY_SCHEDULED", outcome: "RECOVERED", hoursToResolution: 14 },
  ],
  clock: { now: () => new Date("2026-09-01T10:05:00.000Z") },
};

const started = Date.now();
const proposal = await runRecoveryAgent(
  deps,
  {
    model: resolveModel(model, {
      openRouterApiKey: config.OPENROUTER_API_KEY,
      googleApiKey: config.GOOGLE_GENERATIVE_AI_API_KEY,
    }),
    stepBudget: config.AGENT_STEP_BUDGET,
    deadlineMs: 90_000,
  },
  {
    onReasoningDelta: (t) => process.stdout.write(t),
    onToolCall: (n) => process.stderr.write(`\n[tool] ${n}\n`),
  },
);

console.log("\n\n--- proposal ---");
console.log(JSON.stringify(proposal, null, 2));
console.log(`\nmodel=${model}  toolCalls=${proposal.toolCalls}  degraded=${proposal.degraded}  ${((Date.now() - started) / 1000).toFixed(1)}s`);
