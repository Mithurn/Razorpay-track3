# Recovery Room — Engineering Rules

An AI agent that recovers failed payments, for the **Razorpay AI Buildathon, Track 3**.
Read `context/PROJECT.md` in full before writing any code — it is the product brief and the
3-day plan. `context/` is gitignored (internal notes); never commit it.

Deadline: **5 September 2026.** Ship fast, but the repo must read like production code:
clean, layered, SOLID, every value real, every failure path handled and tested.

## Stack — locked

Node 20+ / TypeScript (ESM, `tsx` for dev, no build step for dev) · Fastify · PostgreSQL 16 ·
Redis + BullMQ · **Mastra** (`@mastra/core`) for the agent, no other agent framework ·
`@ai-sdk/google` with a plain `GEMINI_API_KEY` (Gemini 2.5 Flash; no GCP/Vertex) · Zod at every
external boundary · Razorpay test-mode APIs · React + Vite (thin UI) · Docker Compose · Vitest.

Do not add a dependency without stating what problem it solves and why the stack can't. No ORM
(use `pg` + hand-written SQL). No `@assistant-ui/*`.

## Repository structure — keep it this shape

```
src/
  config.ts              env parsing (Zod), the only place process.env is read
  main.ts                composition root — wires dependencies, starts server + worker
  domain/                pure: types + business rules, ZERO I/O, no imports from below
    failure.ts             RootCause enum, Diagnosis schema
    recovery-action.ts     RecoveryAction union, caution ordering
    case.ts                RecoveryCase, Lane state
  agent/                 the Mastra recovery agent
    recovery-agent.ts      the bounded investigation loop -> AgentProposal
    tools.ts               investigation tools (local reads only)
    prompt.ts
  safety/
    safety-gate.ts         pure: clamp / veto / dedupe a proposal (can only add caution)
  execution/             the only code that talks to Razorpay
    razorpay-client.ts     test-mode adapter + HMAC webhook verification
    attempt-executor.ts    perform one attempt exactly-once, re-check on ambiguity
  persistence/           the only code that talks to Postgres
    pool.ts
    case-repository.ts
    event-log.ts           append-only audit writer
  worker/
    recovery-worker.ts     BullMQ: case -> agent -> gate -> executor -> record -> next
  api/
    server.ts
    routes/                cases.ts, runs.ts, stream.ts (SSE)
bench/                   the two-arm evaluation (fixed schedule vs agent)
  generate.ts, run.ts, metrics.ts
web/                     Vite + React — the Recovery Room UI
db/schema.sql            schema + role grants (append-only enforced here)
tests/
```

## Layering (dependency rule)

```
api / worker / bench   →   agent · safety · execution · persistence   →   domain
                                        ↑ infrastructure adapters ↑
```

- `domain/` imports nothing from other `src/` folders. Pure functions and types only.
- `agent/`, `safety/`, `execution/`, `persistence/` depend on `domain/` and on **interfaces**,
  never on `pg`, the Razorpay SDK, or BullMQ types leaking upward.
- `worker/`, `api/`, `bench/` orchestrate; they hold no business rules.
- HTTP DTOs, DB rows, Razorpay responses, and domain objects are distinct types — convert
  explicitly at the boundary (Zod).
- No circular imports. No global mutable state. Composition happens only in `main.ts`.

## The one rule that must not be weakened

**The agent owns the recovery strategy. Deterministic code fences it — it can force more
caution, never less.**

- `agent/recovery-agent.ts` is a genuine bounded tool-loop: it picks which tools to call,
  reasons over what it finds (streamed to the UI), and returns an `AgentProposal`. Bounded by a
  step budget, a wall-clock deadline, a forced conclusion on the last step, and degrade-to-safe
  on timeout/error.
- `safety/safety-gate.ts` is a **pure function**. It can only clamp (attempt past the cap →
  `ESCALATE`), veto (`risk_hold` or amount over the exposure cap → `ESCALATE`), or dedupe
  (inside cooldown → `SKIP`). It never picks the action. It can only move an outcome UP the
  caution ladder (`CAUTION_RANK`).
- `execution/attempt-executor.ts` performs the action exactly-once (one idempotency key per
  attempt), and on a Razorpay 5xx / timeout it re-checks `GET /payments/:id` before concluding —
  never assumes success, never double-charges.

The LLM has no path to move money past a cap, past the attempt limit, or twice.

## Invariants (executable tests, not prose)

- `safetyGate` can only raise caution: for every proposal + context, its result ranks ≥ the
  proposal on `CAUTION_RANK`. Property-test this.
- A proposal at attempt > `maxAttempts`, with `riskHold`, or over `maxExposurePaise` → `ESCALATE`,
  and no Razorpay call is made.
- A malformed / missing / timed-out agent proposal → the safe fallback (`RETRY_SCHEDULED +48h`
  or `ESCALATE`), never a crash, never a fabricated `RootCause`.
- One attempt = one `idempotency_key` = at most one Razorpay order/link.
- Razorpay 5xx mid-attempt → the attempt is not marked `RECOVERED` or `FAILED` until a re-check
  resolves it; no second charge.
- Duplicate webhooks (same Razorpay event id) are ignored.
- `recovery_events` and `razorpay_webhooks` cannot be UPDATEd/DELETEd by the app DB role —
  an integration test connects as `recovery_app`, tries, and expects `permission denied`.
- **`recovered_paise` is summed from real recorded captures. Never estimated, never hard-coded.**

## Evaluation

- Two arms, one synthetic batch: `fixed` (retry day 1/3/5/7) vs `agent`.
- Report ₹ recovered, recovery rate, mean attempts/recovery, time-to-recovery, over-nudge rate
  (contacted customers who'd have self-recovered), escalation rate, and an honest exception list.
  Publish the numbers as-is — do not tune the corpus to flatter the agent, do not chase 1.0.
- A full ~120-case real-model run finishes in ~5–8 min (agent bounded to ~4–6 fast local-read
  tool calls per case, ~10 cases concurrent). `--mock` replays recorded turns in seconds. Past
  ~10 min is a bug.

## Reliability

Every external call (Razorpay, LLM, queue, webhook) has an explicit model for: success · failure
· timeout/unknown · duplicate · malformed. For each state transition ask: what if the process
dies immediately before or after this? Worker crash + retry must not corrupt state or cause an
unintended charge. Transactions for atomic writes; never hold one open across a slow external
call.

## Code quality

Correctness → Security → Reliability → Modularity → Testability → Observability → Performance →
Convenience. Small cohesive functions, honest names, early returns, explicit control flow.
Prefer immutable values for anything safety-relevant. **Near-zero comments** — only for a
non-obvious constraint or a genuine workaround; never restate the code. No dead code, no
commented-out code, no debug logging, **no TODO comments in committed code** (open an issue or
leave it out). Never swallow an error; distinguish validation errors, business decisions,
dependency failures, and unknown external outcomes. Never log secrets or customer PII. Carry a
`caseId` across the whole lifecycle.

## BREAKS.md discipline

The moment something breaks, hangs, or exposes a wrong assumption, add an entry to
`context/BREAKS.md`: expected · actual · why · how diagnosed · how fixed · the permanent
safeguard. The submission form asks "what broke, and how you got out" and reads it first. Never
reconstruct failures at the end.

## Decision log

Any material decision (stack, architecture, scope cut) → a dated entry in `context/NOTES.md`.

## Git

Never commit, push, or open PRs unless asked. Repo Git identity only. Concise commit messages:
what changed and how. No em dashes. One logical change per commit. `context/` and `.env` are
gitignored — keep it that way.

## Definition of done (per task)

Follows the layering + the agent/safety/executor boundary. External inputs Zod-validated.
Failure paths handled with tests. Relevant invariants have tests. No LLM path to money. No mocks
in production paths, no scaffolding left behind. `npm run typecheck` clean. Targeted tests pass.
`context/BREAKS.md` updated if anything broke. The diff is small and reviewable.
