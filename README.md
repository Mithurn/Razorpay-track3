# Recovery Room

Built for the **Razorpay AI Buildathon — Track 3 (AI Revenue Recovery).**

## The problem

Every recurring merchant on Razorpay loses 5–15% of revenue to *involuntary* churn — payments
that fail for **fixable** reasons (expired card, insufficient funds at the wrong time, bank
downtime, soft decline). Today recovery is a dumb fixed retry schedule or a human.

Recovering the payment is the easy half — a fixed schedule already does that, badly. The hard
half is that every recovery action is a **regulated money action**: reattempt an expired card and
the card networks fine the merchant for it; contact a customer at 2am and that's an RBI Fair
Practices Code violation; auto-retry a risk-flagged payment and you've built a fraud tool, not a
recovery one. So this project spends most of its engineering not on the agent, but on the
deterministic fence around it — the part that decides whether the agent's judgment is ever allowed
to touch money at all.

## What it does

A failed payment enters as a case. A bounded AI agent investigates it — pulls the customer's
payment history, checks whether the issuing bank is in a **live Razorpay downtime window**, looks
at what worked for similar cases and at this case's own prior attempts — reasons out loud (you
watch it stream), and proposes one recovery move: retry now, retry at a better time, send a
payment link on a different rail, nudge the customer to update their method, escalate to a human,
or write it off.

A deterministic **safety gate** (a pure function) can only make that proposal *more* cautious — it
enforces an attempt cap, a rupee exposure limit, a charge cooldown, a separate contact cooldown, a
confidence floor, the RBI Fair Practices contact window (08:00–19:00 IST), and a mandatory
escalation on risk-flagged payments (read from the case data, not from the agent's own diagnosis).
No LLM-originated proposal can lower caution. The one deliberate exception: a recorded human
authorization on an already-escalated case can satisfy exactly two of the eight rules (the risk
hold and the exposure cap — the two that exist to force a human decision), and never the two that
carry regulatory weight (the hard-decline veto, the attempt cap) or either cooldown.

The **executor** performs the move against Razorpay test mode exactly once (one idempotency key
per attempt), and on an ambiguous response (5xx / timeout) it re-checks before concluding — so it
never double-charges. If the attempt fails, the result goes back to the agent and it re-plans.

You watch all of it: cards flowing through lanes, the agent's reasoning streaming token by token,
escalations landing in a "waiting on you" rail with working retry/redirect/write-off controls, a
real Razorpay Checkout button once an order or link genuinely exists, and a scoreboard against two
honest baselines.

## The number

One synthetic batch of 60 failed payments, using only Razorpay's own `error_reason` values and
ground-truth recoverability, run through three arms on the same gate, executor and ledger with
only the brain swapped. The corpus is deliberately adversarial: roughly a fifth of the
generic-decline cases (`card_declined` / `payment_failed`) are actually in a live Razorpay downtime
window — same error code, opposite cause; the two `insufficient_funds` templates are distinguished
only by a genuine trend in the customer's own payment history, not a fixed record count; a slice
of `card_expired` cases self-recover before contact (an issuer account-updater fixing the card),
so a wrong nudge is measurable; and a fifth tier of case amounts sits above the exposure cap, so
that guardrail fires in the batch itself, not only in a unit test. None of these signals are
visible from the error code alone, and the agent's own playbook no longer states timing numbers
that match the ground truth — it points at the tools that carry the real signal instead.

|                          | agent      | fixed      | rules table |
|--------------------------|------------|------------|-------------|
| recovered                | 33 / 60    | 20 / 60    | 36 / 60     |
| recovery rate            | 55.0%      | 33.3%      | 60.0%       |
| ₹ recovered              | ₹52,967    | ₹31,480    | ₹56,464     |
| ₹ recoverable (ceiling)  | ₹1,08,456  | ₹1,08,456  | ₹1,08,456   |
| escalation rate          | 38.3%      | 66.7%      | 40.0%       |
| over-nudge rate          | 3.3%       | 0.0%       | 1.7%        |
| mean attempts/recovery   | 1.18       | 1.30       | 1.03        |
| mean hours to recovery   | 32.2       | 38.4       | 28.2        |
| **root-cause accuracy**  | **71.7%**  | — (no diagnosis) | — (no diagnosis) |
| undiagnosed (degraded)   | 1 / 60     | —          | —           |

Seed 42, `google/gemini-3.6-flash`. Reproduce it for free, no API key:
`npm run bench -- --size 60 --seed 42 --mock`.

**Read the money rows honestly: it's close, and sometimes it loses.** The agent recovers three
fewer cases than the rules table and ₹3,497 less. Run across five seeds (42, 7, 13, 99, 2024) the
agent's recovery rate ranges **46.7%–58.3% (mean 52.3%)** against the rules table's 55.0%–63.3%,
a real, sometimes double-digit gap — not a cherry-picked win. On a templated corpus, a 6-line
switch statement on `error_reason` (`bench/rules-arm.ts`, transcribed straight from the agent's
own playbook) is a genuinely strong baseline. That finding survived two hardening passes and this
is the honest version of it.

**The recoverable ceiling is also the tell for why the money rows can't discriminate much
further.** Both arms recover 97–98% of what's genuinely recoverable in this batch — the corpus
isn't hard enough at the *action* level to separate a good policy from a mediocre one. It's hard
enough at the *diagnosis* level, which is the row a lookup table cannot produce at all.

**Root-cause accuracy is where the gap runs the other way, and it's consistent.** `bench/rules-arm.ts`
never diagnoses — it has no concept of *why* a payment failed. Across the same five seeds, the
agent's root-cause accuracy holds at **71.7%–75.0% (mean 73.0%)**, with the loop reaching a
diagnosis on all but 2 of 300 cases. That's measured independently of which action the agent then
chose, so one number can't launder the other, and a null diagnosis (the loop degrading before it
concludes) counts as wrong, not excluded — it used to fall back to a hardcoded `"technical"` and
score as a correct answer on two cases; that bug is fixed and gone (see `BREAKS.md`).

**What the free-tier model actually costs you.** Re-running the identical corpus and prompt on
`minimax/minimax-m3:free` — the zero-cost default — collapses: **35.0% recovery, 8.3% root-cause
accuracy (below random chance across seven categories), and the loop degrades before reaching a
diagnosis on 52 of 60 cases (86.7%).** Most of what looked like free-model competence in earlier
rounds of this project was the playbook handing it the answer, not the model reasoning. The paid
model costs roughly $1.20–1.35 per 60-case run (~500 model calls) and is the one this table uses.
`AGENT_MODEL` is an env override for exactly this reason — the model is measured, not assumed.

**Guardrails firing in this batch, not only in the property test:** `contact_window` skipped 10
nudges outside 08:00–19:00 IST, `exposure_cap` clamped 8 over-limit cases to escalation,
`risk_hold` clamped 4, `write_off_unsupported` clamped 1 write-off the agent proposed without an
unrecoverable diagnosis. The exhaustive gate property test (`tests/safety-gate.test.ts`, 32 cases
over 4,608+ generated contexts) proves every rule *can* fire correctly; this is evidence that they
*do*, on real model output, in the measured batch.

Of the 27 unrecovered cases: 16 are stopped correctly by design (8 risk holds that must escalate
by policy, 8 accounts the corpus marks genuinely unfunded) — not misses. The other 11 are real:
mostly bank-downtime and generic-decline cases where a retry timed past the window would have
recovered the payment and didn't. The full transcript for every case, including every miss, is in
`bench/.cache/agent-turns-seed42-n60-google_gemini-3.6-flash.json`.

## What's real, what's stubbed, what's simulated

Razorpay test mode does not decline a card on demand, so the **incoming failure stream is
synthetic** (modeled from real error codes). Everything downstream of a failure is real unless
stated otherwise here:

- **The recovery actions are real** — real Orders, real Payment Links, real payment IDs, a real
  Razorpay Checkout widget in the room UI once an order or link genuinely exists (`GET
  /cases/:id/pay` resolves this server-side, excluding any bench/seeded reference, so only the
  publishable key ever reaches the browser). Verified live: a genuinely captured payment
  (`pay_TXjLb8zQlnk3Wj`, ₹1,499, netbanking) through the full stack — agent → gate → executor →
  a real signed Razorpay webhook delivered through a public tunnel → the case flipping to
  RECOVERED — independent of the bench evaluation entirely.
- **`recovered_paise` is summed from three clearly separated sources, never blended**: **live** (a
  real Razorpay capture), **bench** (ground-truth resolution for the evaluation — the order is
  still created for real; only the authorization result is simulated), and **sim** (the demo's own
  "simulate payment" button, `POST /cases/:id/simulate-capture` — builds a real HMAC-signed
  `payment.captured` webhook through the exact same handler a live delivery hits, but self-signed,
  payment id always prefixed `pay_sim_`, kept only as the offline fallback when no tunnel is
  running).
- **`CUSTOMER_NUDGE` is a labeled stub, not a channel.** No email/SMS/WhatsApp provider is wired.
  The executor calls a `NotificationPort`; the shipped adapter (`LoggingNotifier`) records a
  `NUDGE_QUEUED` event with `delivered: false` and the attempt resolves — it does not loop forever
  re-checking a delivery that never happens, and nothing downstream ever reads it as sent. Wiring
  a real provider is a connector integration, not a recovery decision, and is out of scope here.
- **The human decision on an escalated case is real and executes.** Clicking retry/redirect on a
  "waiting on you" case records a `HUMAN_DIRECTIVE` in the append-only log; the next pipeline turn
  reads it, performs exactly that action instead of re-running the agent, and the gate still runs
  on it — a human can authorize past a risk hold or the exposure cap, never past the hard-decline
  veto or the attempt cap.
- **`RETRY_SCHEDULED`'s `atHoursFromNow` governs re-attempt spacing, not the first attempt's
  timing.** It decides the delay before the *next* attempt if this one fails, but the order for
  the current attempt is created immediately either way. A production version would hold the
  charge itself until the scheduled time; this build always creates it now, since deferring it
  changes the worker's execution model in ways worth doing deliberately, not under a deadline.
- **One merchant, one currency, card only.** No UPI/netbanking origination, no subscriptions or
  mandates, no multi-tenancy. Said plainly rather than left for a reviewer to find.

## Architecture

```
api / worker / bench   →   agent · safety · execution · persistence   →   domain
```

Arrows point down, and it's enforced, not just documented: `tests/architecture.test.ts` walks
every import under `src/` and asserts `domain/` depends on nothing but `zod`, `safety/` depends
only on `domain/`, no adapter layer imports upward into `worker/`/`api/`/`bench/`, and `pg` /
`bullmq` / `ioredis` stay confined to the layer that owns them. It caught a real violation
(`execution/webhook-handler.ts` importing `bullmq` directly) the first time it ran — fixed with a
`CaseEnqueuer` port, the same pattern used everywhere else here.

- **Ports & adapters.** `src/domain/ports.ts` defines what the outside world must provide
  (`CaseRepository`, `EventLog`, `PaymentGateway`, `NotificationPort`, `CaseEnqueuer`); Postgres,
  Razorpay, BullMQ and the logging notifier are adapters wired only in `src/main.ts`.
- **Anti-corruption layer.** `src/domain/gateway.ts` is explicitly "our vocabulary for the payment
  gateway, not Razorpay's" — adapters translate at the boundary, so a Razorpay API shape never
  leaks into a domain type.
- **Decorators**, not conditionals, for cross-cutting concerns: `LanePublishingCaseRepository` and
  `PublishingEventLog` wrap the Postgres repositories to mirror every write onto the live SSE
  stream, without either repository knowing a stream exists.
- **Optimistic concurrency**: every lane transition is a compare-and-set (`moveLane(id, from, to)`)
  against the lane the caller last read, so two concurrent workers can never both win a turn on
  the same case.
- **Claim-before-side-effect**: the attempt row (with its unique idempotency key) is inserted
  *before* any Razorpay call, so a crash mid-flight leaves a durable claim, never a lost or
  doubled attempt.
- **Least privilege at the grant, not the convention**: `recovery_events` and `razorpay_webhooks`
  are append-only because the database role literally cannot `UPDATE`/`DELETE` them
  (`db/schema.sql`) — proved live by a button in the room UI that connects as the app role and
  shows the database refusing the edit.
- **Safety as a pure function**: `src/safety/safety-gate.ts` takes a proposal and a context, and
  returns a decision. No I/O, no side effects, exhaustively property-tested (4,608+ generated
  contexts) rather than sampled.

**12 runtime dependencies, deliberately.** No agent framework (an earlier version of this project
used one; the step budget, deadline, forced conclusion and degrade-to-safe are what this
submission is judged on, so they're owned code, not framework configuration — see `BREAKS.md`). No
ORM (would cost the DB-grant append-only proof). No DI container (`src/main.ts` is 130 legible
lines). No state machine library (nine lane constants plus compare-and-set already say it). No
Result-type library (`GatewayRejectedError` vs `GatewayUnavailableError` is the actual insight; a
monad on top of it is style). Each dependency earns its place; nothing was added to look
sophisticated.

- `src/domain/` — pure types and rules, zero I/O.
- `src/safety/safety-gate.ts` — the fence. Nine rules total: risk hold, a hard-decline veto on any
  automatic reattempt (Visa/Mastercard fine merchants for reattempting a decline that won't clear
  on its own), the attempt cap, the exposure cap, the confidence floor, the charge cooldown, a
  separate contact cooldown, the RBI contact window, and the write-off-needs-diagnosis rule. A
  recorded human authorization can lift exactly two of the nine.
- `src/agent/` — a hand-rolled bounded loop on the Vercel AI SDK (no agent framework). Bounded by
  a step budget, a wall-clock deadline, a forced conclusion on the last step, and degrade-to-safe:
  a missing / malformed / timed-out proposal returns a scheduled retry with a `null` root cause,
  never a guess and never a throw. The merchant's default-move-per-cause table lives behind a tool
  call (`get_recovery_playbook`), not in the system prompt — the model has to choose to consult
  it, and the notes describe mechanism, not timing, so the investigation is real work, not
  retrieval.
- `src/execution/` — the only code that talks to Razorpay.
- `src/persistence/` — the only code that talks to Postgres.
- `src/worker/` — BullMQ: case → agent → gate → executor → record → schedule next.
- `bench/` — the three-arm evaluation (agent, fixed schedule, rules table).

## Run it

```bash
cp .env.example .env      # OPENROUTER_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY + Razorpay test keys
docker compose up -d      # postgres :5434, redis :6381
npm install
./start.sh                # infra + schema + seed + API (:3000) and web (:5173)
npm test                  # 209 tests (needs docker compose up)

# the evaluation — agent, fixed schedule, and the rules table, on one batch
AGENT_MODEL=google/gemini-3.6-flash npx tsx --env-file=.env bench/run.ts --size 60   # records
npx tsx --env-file=.env bench/run.ts --size 60 --mock                               # replays, free

# seed the live demo queue
npx tsx --env-file=.env bench/seed-demo.ts
npx tsx --env-file=.env bench/smoke.ts                 # one real agent run against a known case
```

## Stack

Node 20+ / TypeScript (ESM) · Fastify · PostgreSQL 16 · Redis + BullMQ · a hand-rolled bounded
agent loop on the Vercel AI SDK (`ai` v7) · `@openrouter/ai-sdk-provider` · Zod at every boundary ·
Razorpay test-mode APIs and Checkout · React + Vite · Docker Compose · Vitest.

## What broke, and how we got out

The submission form's last question, kept as a live log rather than reconstructed at the end — the
full log is [`BREAKS.md`](./BREAKS.md). The short version: an earlier version of this project was
an authorization layer for agentic payments; we measured its AI component performing worse than
plain deterministic rules and pivoted to recovery. The bench went through several rounds of
self-audit before shipping, each one lowering a number rather than protecting it: handing the
agent its own ground truth through a too-informative failure detail (found, fixed, the honest
number dropped and the agent briefly *lost* to the fixed schedule); grading an action at the
instant it was decided rather than the hour it would settle, which specifically punished the agent
for acting early; the live downtime tool matching on payment *method* instead of the specific
issuer, so the audit trail carried confidently-worded but fabricated claims about named banks being
down; and, in this final pass, a fallback constant (`?? "technical"`) that let a degraded
investigation's missing diagnosis silently score as a correct one — found in a final self-audit the
day before submission, root-cause accuracy corrected 71.7%→68.3% on the spot, then re-measured
honestly at 71.7-75.0% once the model itself stopped being the thing degrading. Full detail,
including the escalation rail that used to be a dead end and the guardrail that was quietly
disarmed by its own bug, is in `BREAKS.md`.
