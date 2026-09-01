# Recovery Room — Razorpay AI Buildathon, Track 3 (AI Revenue Recovery)

> This is the master brief. Read it fully before building. The approved plan it derives from is
> in the previous session's plan file; this is the self-contained version.

## What we are building

**A live AI agent that works a queue of failed Razorpay payments** — diagnoses why each one
failed, decides the right recovery move, executes it against Razorpay test-mode, and pulls a
human in when it should. You *watch* it work: case cards flowing through lanes, the agent's
reasoning streaming token-by-token, a "waiting on you" rail for approvals, and a scoreboard that
proves it beats a dumb fixed retry schedule.

**Track 3 bar (verbatim):** *"Don't just identify the problem. Show measured money recovered
across a batch, with compliant escalation, stopping rules, and an audit trail."*

## Why this, and the history

We first built **Aegis** — an authorization/trust layer for agentic payments (~9,000 lines,
preserved on branch `phase-4-frontend` of the old `RazorPay-build` repo). It was aimed wrong:
authorization is deterministic by nature, so we built an excellent deterministic system and then
had to *invent* a job for the AI that the system didn't need. Its AI arm measured *worse* than
its rules arm. That is a **criterion-3 failure** on Razorpay's rubric ("the right tool in the
right place, and where you chose not to use one") — heavy engineering where a rule belonged, no
real seat for the AI.

Payment recovery fixes that: the AI does the part a rule genuinely cannot (read a messy failure
+ customer context, choose a contextual intervention, judge when to stop), and the deterministic
layer does the part that must be exact (retry caps, ₹ limits, idempotency, no double-charge).
**The pivot story itself is our "what broke, and how you got out" answer** — the form field
Razorpay reads first.

## The problem (real)

Every recurring / subscription merchant on Razorpay loses 5–15% of revenue to *involuntary*
churn — payments that fail for *fixable* reasons: expired card, insufficient funds at the wrong
time, bank downtime, soft decline, risk hold. Recovery today is a fixed retry schedule
(day 1/3/5/7) or manual. Both leave money on the table **and** annoy customers who would have
paid anyway.

## Architecture: a real agent, fenced by deterministic safety (not a scripted pipeline)

This is the important call. It is a **genuine tool-using agent loop** — the LLM owns the
recovery *strategy*; deterministic code owns only *safety*.

```
failed payment  →  the Recovery Agent (Mastra Agent, bounded loop):

  ┌─ INVESTIGATE  the agent chooses which tools to call, in what order:
  │    get_customer_history · check_bank_downtime · get_attempt_history ·
  │    get_similar_recovered_cases · get_downtime_window
  │    (all fast local reads; the agent's reasoning streams to the UI as it goes)
  │
  ├─ PROPOSE      the agent proposes a RecoveryAction with reasoning — its judgment:
  │    RETRY_NOW · RETRY_AT(t) · PAYMENT_LINK(rail) · CUSTOMER_NUDGE · ESCALATE · WRITE_OFF
  │
  ├─ SAFETY GATE  deterministic, pure. NOT a decision-maker — it can only:
  │    clamp (attempt N+1 past the cap → forced ESCALATE) ·
  │    veto (risk_hold flag → forced ESCALATE; ₹ over exposure cap → forced ESCALATE) ·
  │    dedupe (idempotency key; cooldown not elapsed → SKIP)
  │    It never picks the action. Every clamp is logged with a reason.
  │
  ├─ EXECUTE      the executor performs it exactly-once against Razorpay test-mode,
  │    reconciles on 5xx/timeout, never double-charges
  │
  └─ OBSERVE      the outcome goes back to the agent. Attempt failed + budget left?
       → the agent re-plans (different action / escalate / write off). This is the loop.

  RECORD          every tool call, proposal, clamp, execution, outcome → recovery_events (append-only)
```

**Why this is the right agent for money, not a free-for-all and not a script:**
- **The LLM makes the judgment calls** — which context matters, which intervention fits, when to
  stop. That is real agency and it is exactly what a rule cannot do (read a messy decline +
  customer history and choose *timing* vs *a new rail* vs *give up*).
- **Deterministic code cannot be talked into an unsafe move.** The safety gate is a `max()` over
  hard limits, like Aegis's gate lattice — it can force *more* caution (ESCALATE), never less. No
  LLM output moves money past a cap, past the attempt limit, or twice. That is the honest
  "where we chose not to use AI" — and it is a fence around the agent, not a replacement for it.
- **Bounded and fast.** Step budget (~4–6 tool calls), wall-clock deadline, forced conclusion on
  the last step, degrade-to-safe (conservative fixed retry) on timeout/error. Tools are local DB
  reads. A case is ~15–30s; 120 cases run concurrently (~10 at a time) in **~5–8 minutes**, and
  `--mock` mode replays recorded LLM turns in seconds for logic iteration.

Reuse the bounded-loop implementation from Aegis's `src/investigation/investigator.ts` (on
branch `phase-4-frontend` of the old repo) — step budget, `withTimeout`, forced-conclusion
nudge, `degrade()` to a safe outcome. It is good code; adapt it, don't rewrite it.

We use **Mastra** for the agent (`Agent` with `tools`, `.stream()` → `fullStream` to the UI) —
matches `superkalam-ai`, streams natively, `mastra dev` steps through it. Swap Mastra's Vertex
model factory for `createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY })`.

## Root causes and interventions

| rootCause | signal | intervention | why a rule can't decide it |
|---|---|---|---|
| `hard_decline` | card dead / lost / stolen / expired | request card update (customer nudge), no blind retry | needs to read the decline reason + know a retry is pointless |
| `insufficient_funds` | `do_not_honor` w/ balance signal, payday patterns | retry timed near the customer's historical success window | needs *timing* judgment from history, not a fixed day |
| `bank_downtime` | issuer in a Razorpay Downtime window | wait for the window to clear, then retry | needs to correlate with downtime data |
| `soft_decline` | `do_not_honor`, transient gateway | one retry soon (6–12h) | one retry only — a rule would over-retry |
| `risk_hold` | risk/fraud flag | escalate to a human, do not auto-retry | compliance judgment |
| `technical` | `GATEWAY_ERROR`, `SERVER_ERROR` | immediate retry | fine for a rule, included for coverage |
| `unrecoverable` | repeated hard declines, exhausted budget | write off, stop | the *stopping rule* |

## The number (honest — Razorpay says "one cherry-picked match proves nothing")

- **Synthetic batch** of ~120–150 failed payments across the root causes, each with a
  ground-truth "recoverable via intervention X at time T" or "genuinely unrecoverable" label,
  plus ~15% "would have self-recovered anyway" (the false-positive-cost controls). Realistic
  Razorpay error codes (`BAD_REQUEST_ERROR`/`GATEWAY_ERROR`, `do_not_honor`,
  `international_transaction_not_allowed`, downtime).
- **Two arms:** `fixed` (retry day 1/3/5/7) vs `agent`.
- **Report:** ₹ recovered, recovery rate %, mean attempts per recovery, mean time-to-recovery,
  **over-nudge rate** (customers contacted who'd have self-recovered = the FP cost), escalation
  rate, and the **honest exception list** (what it couldn't recover and why).
- The win is the agent beating `fixed` on *₹ recovered per unit of customer annoyance* — a real,
  defensible composite. Publish it as-is even if it's modest.
- Synthetic is fine and expected for Track 3/4 ("50+ records of synthetic data" is literally
  Track 4's brief). Credibility = realistic error codes + a real baseline + an honest exception
  list, **not** claiming it's real merchant data.

## Honest caveat (put this in the README)

Razorpay test mode does not literally decline a card on demand. So: the *incoming failure
stream* is synthetic (modeled from real error codes); the *recovery actions* are **real
test-mode API calls** — real Orders, real Payment Links, real captures, real payment IDs. The
agent's judgment and its execution are real; the failures are simulated. For the live demo,
create 1–2 genuinely-failed payments via Razorpay's mock payment page (the "Failure" button —
see `context/BREAKS.md`) and recover those on camera.

## The UI — "Recovery Room" (NOT a dashboard)

Reference: the Guildly / xeno-grow screenshots in `context/reference/` — agents as living
teammates in a place you watch, with a "waiting on you" seat.

- **Case-flow lanes** (animated): `INCOMING → DIAGNOSING → DECIDING → ATTEMPTING →
  RECOVERED · RETRY-SCHEDULED · ESCALATED · WRITTEN-OFF`. Cards slide between lanes as state changes.
- **Live case pane** — open a card, watch the agent's reasoning stream token-by-token (use the
  word-fade effect from `superkalam-chat`'s `rehypeWordFade.ts` + `.sk-word` keyframes), then the
  Razorpay call fires on screen and the result comes back.
- **"Waiting on you" rail** — escalated cases; approve / redirect buttons. This *is* the
  "compliant escalation" bar, made visible.
- **Scoreboard** — the batch run: agent vs fixed, real ₹ figures, exception list.

## Hard constraints (non-negotiable)

1. **Every value has an endpoint.** Nothing lives only in a log line. REST for history/detail,
   SSE for live. The UI is 100% API-driven, nothing hard-coded or faked for the demo.
2. **Backend bulletproof.** ₹ recovered is *summed from real recorded captures*, never
   estimated. Every LLM output Zod-validated at the boundary; malformed → deterministic fallback,
   never a crash, never a guess. Exactly-once execution (idempotency keys + CAS state
   transitions), append-only ledger, reconcile on ambiguity, never double-charge. All
   executable-test-backed.
3. **No slow eval.** A full 120-case real-model run finishes in ~5–8 min (agent loop bounded to
   ~4–6 fast local-read tool calls per case, ~10 cases concurrent). `--mock` mode replays
   recorded agent turns in seconds for pure-logic iteration. If a run creeps past ~10 min that
   is a bug — check the step budget and the concurrency limit. This is the pain that sank Aegis
   (its investigator did full chain-of-thought per turn, 3–6 min *per case*); do not repeat it.
4. **Fail-closed.** LLM down/timeout → agent degrades to a conservative deterministic fixed
   retry. Razorpay 5xx mid-attempt → `AWAITING_RECONCILIATION`, reconcile against
   `GET /payments/:id`, never double-charge, never count until confirmed.

## API surface (target)

- `GET /cases`, `GET /cases/:id` (full detail: failed payment, customer history, every
  diagnosis + decision + attempt + Razorpay result, current lane, audit tape)
- `GET /cases/:id/stream` — SSE: `text-delta` reasoning + `{type:"action",tool,status,result}` +
  lane transitions
- `GET /queue` (waiting-on-you), `POST /cases/:id/decision` (approve/redirect)
- `GET /runs/:id` (scoreboard), `GET /runs/:id/cases` (both arms side by side)
- `GET /events?caseId=` (raw audit tape)
- `GET /health`, `GET /model-health` (provider reachability + latency)

## Stack

- **Fastify + Mastra + Vite/React**, `@ai-sdk/google` with a plain `GEMINI_API_KEY` (no
  GCP/Vertex). Gemini 2.5 Flash primary. `@mastra/pg` for agent memory; raw `pg` for domain tables.
- **BullMQ + Redis** for scheduled retries ("retry at time T") — pattern from
  `wiser-internal/src/helpers/bullmq/articleProcessorQueue.ts` (Queue+Worker+backoff+
  `UnrecoverableError`+health-counter). `@bull-board/fastify` for a free queue inspector.
- Postgres 16, Docker Compose (`docker-compose.yml` maps pg :5433, redis :6380).

## What was carried over from Aegis (in this repo, needs adaptation)

These compile against Aegis's mandate/investigation types and **do not typecheck yet** — Day 1
decouples them:

| File | State | Day-1 action |
|---|---|---|
| `src/domain/execution.ts` | clean, keep as-is | none — the state machine + `VALID_FROM` transition table |
| `src/executor/store.ts` | clean, keep as-is | none — `executor_jobs`/`execution_events`/`webhook_events`, CAS `transition()`, `recordEvent()` |
| `src/executor/razorpay.ts`, `razorpay-http.ts` | clean, keep as-is | none — Razorpay client, HMAC webhook verification, 5xx/404 handling |
| `src/executor/executor.ts` | **adapt** | replace `loadAllowDecision`/`mandateUnexpired`/`gatePermitsStart` with an injected `loadAttempt(correlationId) -> {amountPaise} \| null` from the recovery domain; drop mandate/gate imports. Keep `createOrder → capture → reconcile`, `AWAITING_RECONCILIATION`, CAS everywhere — **this reconciliation logic is the crown jewel, do not rewrite it** |
| `src/executor/webhooks.ts` | **adapt** | same decoupling — `proposalAmount` becomes `attemptAmount` |
| `src/ledger/ledger.ts` | **replace** | rewrite as a small generic append-only `recovery_events` ledger (~40 lines): `append(caseId, type, payload)`, `getEvents(caseId)`. No mandate types |
| `src/api/rate-limit.ts` | clean, keep | in-memory IP rate limiter, use on any mutating route |
| `benchmarks/metrics.ts` → `bench/metrics.ts` | **adapt** | redefine the 3 imported types locally; keep the precision/recall/cost math + per-class breakdown + `TerminalOutcome` tally |
| `web/src/lib/{router,format,codename}.ts`, `web/src/styles/*` | clean, keep | tiny hash router, paise formatter, design tokens |
| `web/src/App.tsx`, `web/src/lib/api.ts` | stubs, rewrite | — |
| `src/index.ts` | stub, rewrite | wire the real server |

## 3-day plan

### Day 1 — spine + one case end to end
1. `npm install`. Bring up `docker compose up` (pg + redis).
2. Rewrite `db/init.sql`: `recovery_cases`, `recovery_attempts`, `recovery_events` (append-only,
   DB-role `GRANT SELECT, INSERT` only — keep Aegis's tamper-test discipline), `executor_jobs` /
   `execution_events` / `webhook_events` (from Aegis, unchanged).
3. Decouple `executor.ts` + `webhooks.ts`; write the generic `recovery_events` ledger.
4. `src/agent/` (Mastra): `mastra.ts`, `models.ts` (`createGoogleGenerativeAI`), `tools.ts`
   (the local-read tools listed in the architecture diagram, each a `createTool` with Zod I/O),
   `agent.ts` (the bounded loop — adapt from Aegis `investigator.ts`: step budget, timeout,
   forced conclusion, `degrade()` to a safe `RETRY_AT(+48h)`), `safety-gate.ts` (pure: clamp /
   veto / dedupe, returns the final action + any clamp reason). **Tests:** a proposal past the
   attempt cap is forced to `ESCALATE`; a `risk_hold` proposal is forced to `ESCALATE`; a
   malformed agent conclusion → `degrade()` to the safe action, never a crash; the gate can only
   raise caution, never lower it.
5. `src/recovery/worker.ts` — BullMQ worker: pull case → run the agent → safety gate →
   executor.execute → record outcome → schedule next attempt or resolve the case.
6. One case end to end: seeded `insufficient_funds` failure → diagnosed → "retry in 2d" →
   scheduled → retried → captured → recorded.
7. **Checkpoint:** if Razorpay test-mode retry mechanics fight back, fall back to Track 4
   (multi-source reconciliation — same Mastra skeleton, ground-truth exact). Decide here.

### Day 2 — the number + streaming
1. `bench/generate.ts` — the synthetic batch (see "The number" above).
2. `bench/run.ts` — two arms, mocked clock, real LLM (or `--mock`), concurrent, ~minutes.
   `bench/metrics.ts` — ₹ recovered / recovery rate / attempts / over-nudge / escalations /
   exception list. Iterate the diagnose + decide prompts until `agent` beats `fixed`.
3. SSE: `Agent.stream()` `fullStream` → Fastify SSE endpoint, forwarding `text-delta` +
   `{type:"action",...}` + lane transitions. Client reader = the async-generator pattern from
   `superkalam-chat/src/hooks/useChat/useChat.ts`.
4. Integration tests: 5xx mid-attempt → reconcile → no double charge; LLM timeout → fallback →
   no double charge.

### Day 3 — the Recovery Room + submission
1. Frontend: animated lanes, live case pane (word-fade reasoning), waiting-on-you rail,
   scoreboard. All API-driven.
2. 5-min video: open on "a merchant loses ₹X/month to *fixable* failures", one case's loop live
   (including the agent hitting a wall and re-deciding), a waiting-on-you escalation, the
   scoreboard vs fixed, the 5xx recovery, close on the exception list (honesty beat).
3. `README.md` (what it solves, the number, the two arms, the guardrails, the caveat, what
   broke). Public repo, `docker compose up` verified from a clean clone.
4. Form answers — especially "what broke": the reconciliation/double-charge discipline + the
   Aegis pivot + whatever breaks on days 1–2.

## Reusable patterns from the SuperKalam repos

- **SSE client reader** — `superkalam-web-apps/apps/superkalam-chat/src/hooks/useChat/useChat.ts`
  (async generator: fetch → `getReader()` → `TextDecoder` → split on `\n\n` → `JSON.parse(data:)`).
  Copy nearly verbatim. Discriminated-union event type + `is*` guards from its `types.ts`.
- **Token fade-in for the reasoning pane** — `.../src/components/ui/MarkdownRenderer/rehypeWordFade.ts`
  + `.sk-word` / `.sk-block-reveal` keyframes in `.../src/styles/globals.css`.
- **Do NOT adopt `@assistant-ui/*`** — too heavy for a cards/lanes UI.
- **Mastra workflow patterns** — `superkalam-ai/src/mastra/workflows/doubt.workflow.ts`
  (`createStep` with zod I/O, `Agent.stream()` → `fullStream`, `createGoogleGenerativeAI` swap
  for the Vertex factory), and the SSE + rollback-on-failure shape in `.../chat.service.ts`.
- **BullMQ batch pattern + `callWithRetry` + `parseJSON` (jsonrepair fallback) + classify→decide
  split + controlled-vocabulary validation** — `wiser-internal/src/helpers/bullmq/articleProcessorQueue.ts`,
  `.../src/utils/retry.ts`, `.../src/helpers/langchain/parser.ts`,
  `.../src/helpers/langchain/getPIBRelevance.ts` + `.../src/scripts/scrapers/PIB/relevanceRules.ts`.
