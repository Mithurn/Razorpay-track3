# Recovery Room — Engineering Rules

An AI payment-recovery agent for the Razorpay AI Buildathon, **Track 3 (AI Revenue Recovery)**.
Read `context/PROJECT.md` in full before building anything. Read the newest entries in
`context/BREAKS.md` and `context/NOTES.md` for Razorpay test-mode facts already learned.

Deadline: **5 September 2026.** Build fast, but every value must be real and every failure path
must be handled. This repo was pivoted from a prior project (Aegis); see PROJECT.md.

## Stack — locked

Node.js + TypeScript (ESM, `tsx` for dev, no build step for dev) · Fastify · PostgreSQL 16
(append-only event ledger) · Redis + BullMQ (scheduled retries) · **Mastra** (`@mastra/core`)
for the LLM steps, no other agent framework · `@ai-sdk/google` with a plain `GEMINI_API_KEY`
(Gemini 2.5 Flash; no GCP/Vertex) · Zod at every external boundary · Razorpay test-mode APIs ·
React + Vite (thin UI) · Docker Compose.

Do not add a framework, ORM, or infra component without stating what problem it solves and why
the existing stack can't. No `@assistant-ui/*` (too heavy — hand-roll the SSE reader).

## The one architectural rule that must not be weakened

**A real agent makes the recovery judgment. Deterministic code fences it — it can force more
caution, never less.**

- The Recovery Agent is a genuine Mastra tool-using loop (bounded: step budget, wall-clock
  deadline, forced conclusion, degrade-to-safe). It chooses which tools to call, reasons over
  what it finds (streamed to the UI), and **proposes** a `RecoveryAction` with reasoning. The
  agent owns the *strategy*.
- `safetyGate(proposal, context)` is a **pure function** — it can only clamp (attempt past the
  cap → forced `ESCALATE`), veto (`risk_hold` flag or ₹ over the exposure cap → forced
  `ESCALATE`), or dedupe (idempotency key; cooldown not elapsed → `SKIP`). It **never picks the
  action** and can only move the outcome toward *more* caution, like Aegis's `max()`-over-lattice
  gate. Every clamp is logged with a reason.
- The executor performs the action exactly-once, reconciles on ambiguity, never double-charges.

The LLM has **no path** to move money past a cap, past the attempt limit, or twice. "Where we
chose not to use AI" is the safety gate + the executor — a fence around the agent, not a
replacement for it. That is a headline, not a footnote.

## Invariants (must be executable tests, not prose)

- The safety gate can only raise caution, never lower it: no proposal can produce an outcome
  less cautious than the deterministic floor for that context.
- A proposal past the attempt cap / ₹ exposure cap / with a `risk_hold` flag is forced to
  `ESCALATE` and **no money moves**. A proposal inside the cooldown is `SKIP`ped.
- A malformed / missing / timed-out agent conclusion degrades to the safe action
  (`RETRY_AT(+48h)` or `ESCALATE`) — never a crash, never a fabricated diagnosis.
- LLM unavailable / timeout → conservative fixed-retry fallback, still fail-closed on money.
- Razorpay 5xx / timeout mid-attempt → `AWAITING_RECONCILIATION`, reconciled against
  `GET /payments/:id`; never read as success; never double-charged.
- One attempt = one idempotency key = at most one Razorpay Order; CAS state transitions only.
- `recovery_events` (and `execution_events`) cannot be UPDATEd or DELETEd by the app DB role —
  enforced by `GRANT SELECT, INSERT` only, with an integration test that tries and expects
  failure.
- Duplicate webhooks are idempotent (dedupe on the Razorpay event id, header or body).
- **₹ recovered is summed from real recorded captures. Never estimated, never hard-coded.**

## Evaluation

- Two arms, same synthetic batch: `fixed` (retry day 1/3/5/7) vs `agent`.
- Report ₹ recovered, recovery rate, mean attempts/recovery, time-to-recovery, over-nudge rate
  (FP cost), escalation rate, and an honest exception list. Publish the numbers as-is.
- A full ~120-case real-model run must finish in **~5–8 minutes** (the agent loop is bounded to
  ~4–6 fast local-read tool calls per case; run ~10 cases concurrently). `--mock` mode replays
  recorded agent turns in seconds for pure-logic iteration. If a run creeps past ~10 min, that
  is a bug — check the step budget and concurrency.
- Do not tune the corpus to flatter the agent. Do not chase precision/recall = 1.0 — Razorpay
  says "one cherry-picked match proves nothing."

## Reliability

Every external operation (Razorpay call, LLM call, queue op, webhook) has an explicit model for:
success · failure · timeout/unknown · duplicate · malformed response. For each state transition
ask: what if the process dies immediately before or after this? Worker crashes and retries must
not corrupt state or cause an unintended payment. Use transactions for atomic operations; don't
hold a DB transaction open across a slow external call.

## Code quality

Correctness → Security → Reliability → Modularity → Testability → Observability → Performance →
Convenience, in that order. Small cohesive functions, honest names, early returns. Near-zero
comments — only for a non-obvious constraint or workaround. No dead code, no commented-out code,
no debug logging, no TODOs in committed code. Zod-validate every external input. Never swallow
errors; distinguish validation errors, business decisions, dependency failures, and unknown
external outcomes. Never leak secrets or customer PII into logs. Keep a correlation/case id
across the full lifecycle.

## BREAKS.md discipline

The moment something breaks, hangs, or exposes a wrong assumption, add an entry to
`context/BREAKS.md`: what we expected · what happened · why · how we diagnosed it · how we fixed
it · the permanent safeguard. This is a buildathon deliverable — the form asks "what broke, and
how you got out" and reads it first. Never reconstruct failures at the end.

## Decision log

Any material decision (stack, architecture, scope cut) gets a dated entry in `context/NOTES.md`.

## Git

Never commit, push, or open PRs unless asked. Repository Git identity only. Concise,
human-readable commit messages: what changed and how, not why (unless asked). No em dashes. One
logical change per commit.

## Definition of done (per task)

Production code follows the classify→decide→guardrails→execute boundary. External inputs
validated. Failure paths handled with tests. Relevant invariants have tests. No LLM path to
money. No mocks or scaffolding left in production paths. `npx tsc --noEmit` clean. Targeted
tests pass. `context/BREAKS.md` updated if anything broke. The diff is reviewable.
