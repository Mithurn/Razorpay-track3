# Backend

Agent design, safety contract, execution semantics, persistence guarantees, and how the evaluation harness works. For the product overview and evaluation results see the [root README](../README.md).

---

## Contents

- [Layering](#layering)
- [Case lifecycle](#case-lifecycle)
- [Agent](#agent)
- [Safety gate](#safety-gate)
- [Execution](#execution)
- [Webhook handler](#webhook-handler)
- [Persistence](#persistence)
- [Worker pipeline](#worker-pipeline)
- [Evaluation harness](#evaluation-harness)

---

## Layering

```
api / worker / bench
        ↓
  agent · safety · execution · persistence
        ↓
      domain
```

`domain/` imports nothing from other `src/` packages — pure TypeScript types, Zod schemas, and pure functions. Everything else depends on `domain/` via interfaces. [`tests/architecture.test.ts`](../tests/architecture.test.ts) enforces this at test time by walking every import in the compiled output.

No DI container. Dependencies are constructed at the composition root (`src/main.ts`, `bench/run.ts`) and passed explicitly. No ORM — the DB role grant proof requires running raw SQL.

---

## Case lifecycle

```
INCOMING → DIAGNOSING → DECIDING → ATTEMPTING → RECOVERED
                                              ↘ ESCALATED
                                              ↘ WRITTEN_OFF
                                              ↘ STOPPED
```

`TERMINAL_LANES` and `IN_FLIGHT_LANES` are constants in `src/domain/case.ts`. The pipeline enforces that a terminal case is never re-queued.

---

## Agent

**File:** `src/agent/recovery-agent.ts`

A hand-rolled bounded loop using the Vercel AI SDK's `streamText`. No agent framework — the bounds are owned code because they are what's being measured.

### Bounds

| Bound | Default | Env var |
|-------|---------|---------|
| Step budget | 6 steps | `AGENT_STEP_BUDGET` |
| Wall-clock deadline | 90 s | `AGENT_TIMEOUT_MS` |
| Degrade path | `RETRY_SCHEDULED +48h`, `rootCause: null` | — |

On the final step the system prompt forces a `submit_proposal` call — the agent cannot consume its last step on a tool call. Any exception, timeout, or malformed proposal calls `degrade()`. The root cause is never guessed.

### Tools

| Tool | Source | What it does not expose |
|------|--------|------------------------|
| `get_customer_payment_history` | Postgres | No ground-truth recoverability flag |
| `check_bank_downtime` | Razorpay live API | No timing hints from corpus templates |
| `get_similar_resolved_cases` | Postgres | Returns `hoursToResolution` — see BREAKS.md for leakage note |
| `get_recovery_playbook` | Static lookup | No timing hints; mechanism-level guidance only |
| `get_this_case_prior_attempts` | Postgres | Returns `"payment declined"` on failures, never outcome detail |

### Proposal schema

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
  reasoning: z.string().min(20).max(1500),
}
```

A structurally invalid proposal triggers `degrade()`.

### Cost metering

**File:** `src/agent/budget.ts`

`guardModel` wraps any `LanguageModel` in a Proxy that intercepts `doGenerate` and `doStream`. Token counts are read off the provider's `finish` part. A call with no usage block is counted in `callsWithoutUsage` and charged the flat fallback — never registered as zero. Rates are declared via `AGENT_USD_PER_M_INPUT` / `AGENT_USD_PER_M_OUTPUT`.

The old implementation charged a flat `$0.0025` per call and never read a token. Measured cost on this workload: `$0.0052` — **2.1× low**. Documented in [`BREAKS.md`](../BREAKS.md).

---

## Safety gate

**File:** `src/safety/safety-gate.ts`

A pure function: `(proposal, context, limits) → GateResult`. No I/O, no state. The gate can raise caution but **cannot lower it** — `CAUTION_RANK` enforces this algebraically.

### The nine rules

| Rule | Code location | Test name |
|------|--------------|-----------|
| Risk hold | line 88 | `"ends every risk-hold case at ESCALATE, whatever was proposed"` |
| Write-off gate | line 93 | `"clamps a write-off with no unrecoverable diagnosis to ESCALATE"` |
| Hard decline | line 99 | `"clamps an automatic reattempt on a hard-declined card"` |
| Attempt cap | line 105 | `"forces ESCALATE past the attempt cap"` |
| Contact window | line 110 | `"skips a nudge proposed outside the window"` |
| Contact cooldown | line 115 | `"skips a second nudge inside the contact cooldown"` |
| Exposure cap | line 126 | `"forces ESCALATE over the exposure cap"` |
| Confidence floor | line 131 | `"clamps a money-moving proposal below the floor"` |
| Charge cooldown | line 136 | `"skips a money-moving proposal inside the cooldown"` |

The risk-hold check reads `failureReason` from the **case**, not from `proposal.diagnosisRootCause`. A misdiagnosed case cannot bypass human review. This was fixed after a real bug — see [`BREAKS.md`](../BREAKS.md).

Property test: generates all combinations of `(action, rootCause, confidence) × (riskHold, hardDecline, attemptCap, ...)` across 4,608 inputs and asserts `CAUTION_RANK[result.action.kind] >= CAUTION_RANK[proposal.kind]`.

---

## Execution

**File:** `src/execution/attempt-executor.ts`

### Idempotency

One attempt = one `idempotency_key` = at most one Razorpay order or payment link. The key is `UNIQUE` in `recovery_attempts`. The attempt row is inserted with `CLAIM` status **before** any Razorpay call — two workers racing the same attempt get a database rejection on the second insert.

For a **payment link**, `reference_id` uniqueness is enforced server-side. For an **order**, `receipt` has no server-side uniqueness — a crash-and-reperform that misses an already-created order via list-read lag can create a second one. The one place idempotency depends on Razorpay's guarantees rather than only ours.

### Ambiguous 5xx

A 5xx or timeout mid-create lands the attempt in `AWAITING_RECONCILIATION`. The executor then re-checks the specific artifact it created:

- Retry: `GET /orders/:id/payments`
- Payment link: `GET /payment_links/:id`

It settles only on a captured payment with `amount > 0`. It never concludes from list absence. Razorpay's order list is eventually consistent (minutes lag in test mode).

**Tests:** `"parks an ambiguous 5xx and never charges twice"`, `"settles a parked attempt once the gateway shows a capture"`, `"never creates two Razorpay orders for concurrent calls on the same attempt"`

### Razorpay client behaviours (empirically discovered)

- `receipt` is not unique. `reference_id` is, but only on payment links.
- Throttling returns `400`, not `429`. Classified as `GatewayUnavailableError` (retryable).
- `GatewayUnavailableError` (5xx, timeout, parse failure) → `AWAITING_RECONCILIATION`
- `GatewayRejectedError` (4xx) → `FAILED`

---

## Webhook handler

**File:** `src/execution/webhook-handler.ts`

1. **HMAC verification** — runs before any state change. Invalid signature returns immediately.
2. **Inbox deduplication** — each event written into `razorpay_webhooks` with `event_id` as `UNIQUE` key. Duplicate delivery is a database-level no-op.
3. **Re-delivery safety** — if the process died between recording the event ID and settling the attempt, a re-delivery settles it rather than treating it as a duplicate.

**Tests:** bad signature, duplicate delivery, re-delivery after failed first settle, amount mismatch.

---

## Persistence

**Files:** `src/persistence/`

### Repositories

| Repository | Responsibility |
|-----------|---------------|
| `PostgresCaseRepository` | Case lanes and state transitions |
| `PostgresAttemptRepository` | Attempt creation, claim, resolve, settle |
| `PostgresEventLog` | Append-only event log |
| `WebhookInbox` | Deduplicated webhook store |

### Append-only audit log

`recovery_events` records every proposal, gate decision, Razorpay call, and outcome. The application DB role (`recovery_app`) has `SELECT, INSERT` only — no `UPDATE`, no `DELETE`. Enforced at the Postgres `GRANT` level in [`db/schema.sql`](../db/schema.sql):

```sql
GRANT SELECT, INSERT ON recovery_events, razorpay_webhooks TO recovery_app;
```

This is not a coding convention. A bug in application code cannot modify or delete audit records. [`tests/append-only.integration.test.ts`](../tests/append-only.integration.test.ts) connects as `recovery_app`, runs `UPDATE recovery_events ...`, and asserts the database refuses.

---

## Worker pipeline

**Files:** `src/worker/pipeline.ts`, `src/worker/reconcile-sweep.ts`

The pipeline drives one case through its full lifecycle: claim → agent → gate → execute → outcome → advance lane. BullMQ handles durability and retry on process crash.

The **reconciliation sweep** runs on a timer. It finds `AWAITING_RECONCILIATION` attempts and re-queues them, and force-reclaims cases orphaned in `DIAGNOSING` with no live job.

**Human directives** (`src/worker/human-directive.ts`): an operator can mark an escalated case for retry, redirect (different rail), or write-off. The directive is read on the next pipeline run, short-circuiting the agent call.

---

## Evaluation harness

**Files:** `bench/`

Three arms run against the same corpus, same gate, same executor (mocked Razorpay gateway):

| Arm | Description |
|-----|-------------|
| `agent` | Bounded investigation agent |
| `fixed` | Fixed schedule (retry at T+24h for all failure types) |
| `rules` | 6-case switch on `error_reason` — the agent's own playbook transcribed into code |

### Corpus

**File:** `bench/corpus.ts` — 60 cases from 7 templates keyed by Razorpay `error_reason`. `insufficient_funds` appears twice with opposite ground truth (funds arrive by day 3 vs. never) — the only separating signal is a rising failure trend in customer history, not the failure code. A ~20% override assigns some cases to a live bank-downtime pairing.

Ground truth (`recoverable`, `trueCause`, `selfRecovers`) is set per template and **never accessible to any arm at run time**. Only `GroundTruthResolver` reads it after execution to grade the outcome.

### Ground truth leakage guards

The prior-attempts tool returns `"payment declined"` on failures — never timing hints. The playbook contains no timing values. These were real leaks found and fixed during development; see [`BREAKS.md`](../BREAKS.md).

### Cache / replay

`bench/mock-agent.ts` records every agent turn (proposal + full tool-call trace) keyed by `customerRef#attemptNo#modelId`. `--mock` replays any recording at zero model calls and zero network. Every published result is reproducible:

```bash
AGENT_MODEL=google/gemini-3.6-flash npm run bench -- --size 60 --seed 42 --mock
```

### `--blind-reason`

Replaces every case's `failureCode` and `failureReason` with a single generic value before it reaches any arm. Ground truth is untouched. Tests whether a strategy's edge comes from reading a label or from tool-driven reasoning.

Known coupling: `isRiskHold` reads `failureReason`, so the risk-hold veto never fires in blind mode. `get_similar_resolved_cases` also keys on `failureReason`, so it returns an undifferentiated pool. Both documented in [`BREAKS.md`](../BREAKS.md). `--blind-reason` is an evaluation instrument, not a deployment mode.
