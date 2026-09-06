# Backend

Agent design, the safety contract, execution semantics, persistence guarantees, and how the
evaluation harness works. For the product overview and evaluation results, see the
[root README](../README.md).

---

## Layering

```
api / worker / bench
        ↓
  agent · safety · execution · persistence
        ↓
      domain
```

`domain/` imports nothing from other `src/` packages. It is pure TypeScript types, Zod schemas,
and pure functions. No `pg`, no BullMQ, no Razorpay SDK. Everything else depends on `domain/`
via interfaces, never through a concrete type that leaks an infrastructure dependency upward.

[`tests/architecture.test.ts`](../tests/architecture.test.ts) enforces this at test time by
walking every import in the compiled output. A `persistence/` file importing a BullMQ type would
fail the suite.

No DI container. Dependencies are constructed at the composition root (`src/main.ts`,
`bench/run.ts`) and passed explicitly. No ORM — the DB role grant proof requires running raw SQL,
and an ORM would either abstract that away or require careful bypassing.

---

## Case lifecycle

A case moves through named lanes:

```
INCOMING → DIAGNOSING → DECIDING → ATTEMPTING → RECOVERED
                                              ↘ ESCALATED
                                              ↘ WRITTEN_OFF
                                              ↘ STOPPED
```

`TERMINAL_LANES` and `IN_FLIGHT_LANES` are constants in `src/domain/case.ts`. The pipeline
enforces that a terminal case is never re-queued.

---

## Agent

**File:** `src/agent/recovery-agent.ts`

The agent is a hand-rolled bounded loop using the Vercel AI SDK's `streamText`. There is no
agent framework. The loop is owned code because the bounds are the product: the step budget, the
wall-clock deadline, the forced conclusion, and the degrade-to-safe path are not configuration
knobs inside a framework — they are the behaviour being evaluated.

### Bounds

```typescript
stopWhen: [stepCountIs(config.stepBudget), hasToolCall("submit_proposal")]
abortSignal: AbortSignal.timeout(config.deadlineMs)
```

- **Step budget:** 6 steps (env: `AGENT_STEP_BUDGET`). On the final step the system prompt
  forces a `submit_proposal` call — the agent cannot consume its last step on a tool call.
- **Wall-clock deadline:** 90 seconds by default (env: `AGENT_TIMEOUT_MS`). `AbortSignal.timeout`
  is passed directly to the SDK stream.
- **Degrade path:** any exception, timeout, or malformed proposal calls `degrade()`, which returns
  a `RETRY_SCHEDULED +48h` with `diagnosisRootCause: null` and `degraded: true`. The root cause
  is never guessed.

### Tools

| Tool | Source | What it does not expose |
|------|--------|------------------------|
| `get_customer_payment_history` | Postgres | No ground-truth recoverability flag |
| `check_bank_downtime` | Razorpay live API | No timing hint from corpus templates |
| `get_similar_resolved_cases` | Postgres | Returns `hoursToResolution` (see BREAKS.md for leakage note) |
| `get_recovery_playbook` | Static lookup | No timing hints; mechanism-level guidance only |
| `get_this_case_prior_attempts` | Postgres | Returns `"payment declined"` on failures, never outcome detail |

The prior-attempts tool was the source of a critical benchmark leak: it originally returned
failure detail strings like `"too early, recovers at +72h"` which contained ground truth. It now
returns a flat `"payment declined"`. Documented in [`BREAKS.md`](../BREAKS.md).

### Proposal schema

The agent outputs a `submit_proposal` tool call with this structure (validated by Zod):

```typescript
{
  rootCause: z.enum(["hard_decline", "insufficient_funds", "bank_downtime", "soft_decline",
                      "risk_hold", "technical", "unrecoverable"]),
  confidence: z.number().min(0).max(1),
  actionKind: z.enum(["RETRY_NOW", "RETRY_SCHEDULED", "PAYMENT_LINK",
                       "CUSTOMER_NUDGE", "ESCALATE", "WRITE_OFF"]),
  retryDelayHours: z.number().positive().max(720).optional(),   // required for RETRY_SCHEDULED
  paymentLinkRail: z.enum(["card", "netbanking"]).optional(),   // required for PAYMENT_LINK
  nudgeChannel: z.enum(["email", "sms"]).optional(),            // required for CUSTOMER_NUDGE
  reason: z.string().max(300).optional(),
  reasoning: z.string().min(20).max(1500),
}
```

If the model produces a structurally invalid proposal, `degrade()` fires.

### Cost metering

**File:** `src/agent/budget.ts`

`guardModel` wraps any `LanguageModel` in a Proxy that intercepts `doGenerate` and `doStream`.
Token counts are read off the provider's `finish` part (nested `{ total }` on v3/v4, flat number
on v2). A call with no usage block is counted in `callsWithoutUsage` and charged the flat fallback
rate — it never registers as zero. Rates are declared via `AGENT_USD_PER_M_INPUT` /
`AGENT_USD_PER_M_OUTPUT` (default: Gemini standard tier, $1.50/$7.50).

Seven tests in [`tests/budget.test.ts`](../tests/budget.test.ts) pin both usage shapes, the
stream path, a reported zero as distinct from a missing block, the fallback charge, and the cap.

The old implementation charged a flat `$0.0025` per call and never read a token. Measured, a call
on this workload costs `$0.0052` — the constant was **2.1× low**. Written up in BREAKS.md.

---

## Safety gate

**File:** `src/safety/safety-gate.ts`

A pure function: `(proposal, context, limits) → GateResult`. No I/O. No state. Every call with
the same inputs produces the same output. The gate can raise caution (clamp a retry to escalate,
skip a nudge outside the contact window) but **cannot lower it** — `CAUTION_RANK` enforces this
algebraically.

```typescript
export const CAUTION_RANK: Record<RecoveryAction["kind"], number> = {
  RETRY_NOW: 0, RETRY_SCHEDULED: 1, PAYMENT_LINK: 1,
  CUSTOMER_NUDGE: 2, ESCALATE: 3, WRITE_OFF: 3,
};
// Gate invariant: result.action's CAUTION_RANK >= proposal's CAUTION_RANK.
// Verified by property test across 4,608 input combinations.
```

### The nine rules, with their code locations

| Rule | Code | Test |
|------|------|------|
| Risk hold | `ctx.riskHold`, line 88 | `"ends every risk-hold case at ESCALATE, whatever was proposed"` |
| Write-off gate | `proposal.kind === "WRITE_OFF" && !ctx.unrecoverableDiagnosis`, line 93 | `"clamps a write-off with no unrecoverable diagnosis to ESCALATE"` |
| Hard decline | `ctx.hardDecline && AUTO_REATTEMPT.has(proposal.kind)`, line 99 | `"clamps an automatic reattempt on a hard-declined card, whatever the confidence"` |
| Attempt cap | `ctx.attemptNo > limits.maxAttempts`, line 105 | `"forces ESCALATE past the attempt cap"` |
| Contact window | `isWithinContactWindow(ctx.now)`, line 110 | `"skips a nudge proposed outside the window, and does not touch any other action"` |
| Contact cooldown | `ctx.hoursSinceLastContact < limits.contactCooldownHours`, line 115 | `"skips a second nudge inside the contact cooldown"` |
| Exposure cap | `ctx.case.amountPaise > limits.maxExposurePaise`, line 126 | `"forces ESCALATE over the exposure cap, but only for money-moving proposals"` |
| Confidence floor | `ctx.confidence < limits.minConfidence`, line 131 | `"clamps a money-moving proposal whose confidence is below the floor"` |
| Charge cooldown | `ctx.hoursSinceLastAttempt < limits.cooldownHours`, line 136 | `"skips a money-moving proposal inside the cooldown, and lets it through outside"` |

The risk-hold check reads `failureReason` from the *case*, not from `proposal.diagnosisRootCause`.
This was fixed after a real bug where a misdiagnosed case could bypass human review.
See [`BREAKS.md`](../BREAKS.md) — "Risk-hold wiring bug".

Property test: `"never returns an outcome less cautious than the proposal"` generates all
combinations of `(action, rootCause, confidence) × (riskHold, hardDecline, attemptCap, ...)` and
asserts `CAUTION_RANK[result.action.kind] >= CAUTION_RANK[proposal.kind]`.

---

## Execution

**File:** `src/execution/attempt-executor.ts`

### Idempotency

One attempt = one `idempotency_key` = at most one Razorpay order or payment link. The key is
`UNIQUE` in the `recovery_attempts` table. The attempt row is inserted with `CLAIM` status before
any Razorpay call. If two workers race, the database rejects the second insert — no second call
goes out.

This is exactly-once recovery attempt semantics at the execution boundary. We do not claim
end-to-end exactly-once in the broader sense — queue processing and network partitions can produce
duplicate worker activations, and the claim-before-call pattern is what handles them.

That guarantee holds fully for a payment link, where Razorpay enforces `reference_id` uniqueness
server-side. It does not hold as cleanly for an order: `receipt` has no server-side uniqueness at
all, so a reperform after a crash (see below) that misses an already-created order due to list-read
lag can create a second one. See [`BREAKS.md`](../BREAKS.md).

### Ambiguous 5xx

A 5xx or timeout mid-create does not tell us whether the order/link was created.

```typescript
if (err instanceof GatewayUnavailableError) {
  await this.attempts.resolve(attempt.id, {
    status: "AWAITING_RECONCILIATION", detail: err.message
  });
}
```

The executor then re-checks the artifact it *created*:

- For a retry: `GET /orders/:id/payments` — the order ID it holds from before the 5xx
- For a payment link: `GET /payment_links/:id`

It settles only on a payment with `status === "captured"` and `amount > 0`. It never concludes
from list absence. Ambiguous attempts in `AWAITING_RECONCILIATION` are picked up by the
reconciliation sweep or settled by a subsequent webhook.

Razorpay's order list is eventually consistent (observed lag of minutes in test mode). We cannot
rely on it. This is why we re-check the specific artifact, not the list.

Tests in [`tests/attempt-executor.integration.test.ts`](../tests/attempt-executor.integration.test.ts):

- `"parks an ambiguous 5xx and never charges twice on the next pass"`
- `"settles a parked attempt once the gateway shows a capture, crediting the ledger once"`
- `"never creates two Razorpay orders for two concurrent calls on the same attempt"`

### Razorpay client — empirically discovered behaviours

**File:** `src/execution/razorpay-client.ts`

- `receipt` is not a unique field at Razorpay. `reference_id` is, but only on payment links.
- Throttling returns `400`, not `429`. Classified as `GatewayUnavailableError`, the same as a 5xx —
  a throttled call is retryable, not a rejection of the request itself.
- `GatewayUnavailableError` (5xx, timeout, parse failure) → `AWAITING_RECONCILIATION`
- `GatewayRejectedError` (4xx) → `FAILED`

---

## Webhook handler

**File:** `src/execution/webhook-handler.ts`

1. **HMAC verification.** `client.verifyWebhook(rawBody, signature)` runs before any state
   change. An invalid signature returns `{ status: "invalid_signature" }` immediately.

2. **Inbox deduplication.** Each event is written into `razorpay_webhooks` with its `event_id` as
   a `UNIQUE` key before processing. A duplicate delivery is a silent no-op at the database level.

3. **Re-delivery safety.** If the process died between recording the event ID and settling the
   attempt, a re-delivery settles it instead of being treated as a duplicate no-op. The handler
   checks attempt status and proceeds if still unresolved.

Tests in [`tests/webhook-handler.integration.test.ts`](../tests/webhook-handler.integration.test.ts):

- `"rejects a webhook with a bad signature"`
- `"ignores a duplicate delivery of the same event id"`
- `"settles a redelivered event whose first delivery never finished settling"`
- `"does not credit a capture whose amount does not match the case"`

---

## Persistence

**Files:** `src/persistence/`

### Repositories

- `PostgresCaseRepository` — case lanes and state transitions
- `PostgresAttemptRepository` — attempt creation, claim, resolve, settle
- `PostgresEventLog` — append-only event log
- `WebhookInbox` — deduplicated webhook store

### Append-only audit log

`recovery_events` records every proposal, gate decision, Razorpay call, and outcome. The
application DB role (`recovery_app`) has `SELECT, INSERT` only — no `UPDATE`, no `DELETE`.
Enforced at the Postgres `GRANT` level in [`db/schema.sql`](../db/schema.sql), line 108:

```sql
GRANT SELECT, INSERT ON recovery_events, razorpay_webhooks TO recovery_app;
```

This is not a coding convention. A bug in application code cannot modify or delete audit records.
A test in [`tests/append-only.integration.test.ts`](../tests/append-only.integration.test.ts)
connects as `recovery_app`, runs `UPDATE recovery_events ...`, and asserts the database refuses.

`razorpay_webhooks` has the same grants — the inbox cannot be silently cleared.

---

## Worker pipeline

**Files:** `src/worker/pipeline.ts`, `src/worker/reconcile-sweep.ts`

The pipeline drives one case through its full lifecycle: claim the case, run the agent, pass
through the gate, execute, record outcome, advance lane. BullMQ handles durability and retry on
process crash.

The reconciliation sweep runs on a timer (`src/worker/reconcile-sweep.ts`). It finds cases with
`AWAITING_RECONCILIATION` attempts and re-queues them. It also force-reclaims cases orphaned in
`DIAGNOSING` with no live job (crash between enqueue and dequeue).

Human directives are handled via `src/worker/human-directive.ts`. An operator can mark an
escalated case for retry, redirect (different rail), or write-off. The directive is read on the
next pipeline run.

---

## Evaluation harness

**Files:** `bench/`

Three arms run against the same corpus, same gate, same executor (mocked Razorpay gateway):

- **`agent`** — the bounded investigation agent
- **`fixed`** — fixed schedule (retry at T+24h for all failure types)
- **`rules`** — a 6-case switch on `error_reason` (`bench/rules-arm.ts`) plus a second-attempt
  escalation rule — the agent's own system-prompt playbook, transcribed into code, no model

### Corpus

**File:** `bench/corpus.ts`. 60 cases generated from 7 templates keyed by Razorpay `error_reason`
(`insufficient_funds` appears twice, with opposite ground truth — see below): `insufficient_funds`,
`card_declined`, `card_expired`, `issuer_technical_error`, `payment_failed`,
`payment_risk_check_failed`, and a second `insufficient_funds` template. A separate ~20% override
reassigns some `card_declined`/`payment_failed` cases to a live bank-downtime pairing. Ground truth
(`recoverable`, `trueCause`, `selfRecovers`) is set per template and is **never accessible to any
arm at run time** — only the `GroundTruthResolver` reads it after execution to grade the outcome.

The two `insufficient_funds` templates carry the same `error_reason` and opposite ground truth
(funds arrive by day 3 vs. never) — the only separating signal is a rising failure trend in
customer history, not the failure code or a record count.

### Ground truth leakage guards

The `GroundTruthResolver` grades after the fact. Prior-attempt detail returns `"payment declined"`,
never outcome hints. The `get_recovery_playbook` tool contains no timing values. These were all
real leaks found and fixed during development.

### Cache / replay

`bench/mock-agent.ts` records every agent turn (proposal + full tool-call trace) keyed by
`customerRef#attemptNo`. `--mock` replays any recording at zero model calls and zero network.
Every published result in the README is reproducible:

```bash
AGENT_MODEL=google/gemini-3.6-flash npm run bench -- --size 60 --seed 42 --mock
```

The cache key includes the model ID — a same-shape rerun with a different model produces its own
file, not a silent replay of the previous model's turns.

### `--blind-reason`

Replaces every case's `failureCode` and `failureReason` with a single generic value before it
reaches any arm. Ground truth is untouched. This tests whether a strategy's edge comes from
reading a label that was handed to it, or from reasoning from tools. It is an evaluation
instrument, not a deployment mode.

Known coupling: `isRiskHold` reads `failureReason`, so the risk-hold veto never fires in blind
mode. Documented in BREAKS.md.
