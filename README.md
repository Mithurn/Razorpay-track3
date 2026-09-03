# Recovery Room

An AI agent that recovers failed payments. Built for the **Razorpay AI Buildathon — Track 3
(AI Revenue Recovery).**

## The problem

Every recurring merchant on Razorpay loses 5–15% of revenue to *involuntary* churn — payments
that fail for **fixable** reasons (expired card, insufficient funds at the wrong time, bank
downtime, soft decline). Today recovery is a dumb fixed retry schedule or a human. Both leave
money on the table and annoy customers who would have paid anyway.

## What it does

A failed payment enters as a case. A bounded AI agent investigates it — pulls the customer's
payment history, checks whether the issuing bank is in a **live Razorpay downtime window**,
looks at what worked for similar cases and at this case's own prior attempts — reasons out loud
(you watch it stream), and proposes one recovery move: retry now, retry at a better time, send a
payment link on a different rail, nudge the customer to update their method, escalate to a
human, or write it off.

A deterministic **safety gate** (a pure function) can only make that proposal *more* cautious —
it enforces an attempt cap, a rupee exposure limit, a cooldown, a confidence floor, and a
mandatory escalation on risk-flagged payments (read from the case data, not from the agent's own
diagnosis). The LLM has no path to move money past a cap, past the attempt limit, through a risk
hold, or twice.

The **executor** performs the move against Razorpay test mode exactly once (one idempotency key
per attempt), and on an ambiguous response (5xx / timeout) it re-checks before concluding — so
it never double-charges. If the attempt fails, the result goes back to the agent and it
re-plans.

You watch all of it: cards flowing through lanes, the agent's reasoning streaming token by
token, escalations landing in a "waiting on you" rail, a scoreboard proving it beats the fixed
schedule.

## The number

One synthetic batch of 60 failed payments, using only Razorpay's own `error_reason` values and
ground-truth recoverability, run through three arms on the same gate, executor and ledger with
only the brain swapped. The corpus is deliberately adversarial to a lookup table: roughly a fifth
of the generic-decline cases (`card_declined` / `payment_failed`) are, this time, actually in a
live Razorpay downtime window — same error code, opposite cause — and the two `insufficient_funds`
templates are distinguished only by a genuine trend in the customer's own payment history (cadence,
failure rate), not by a fixed record count. Neither signal is visible from the error code alone.

|                       | agent    | fixed    | rules table    |
|-----------------------|----------|----------|----------------|
| recovered             | 42 / 60  | 28 / 60  | 43 / 60        |
| recovery rate         | 70.0%    | 46.7%    | 71.7%          |
| ₹ recovered           | ₹60,458  | ₹41,972  | ₹59,457        |
| escalation rate       | 30.0%    | 53.3%    | 28.3%          |
| mean attempts/rec     | 1.45     | 1.32     | 1.05           |
| mean hours to rec     | 46.5     | 39.4     | 32.0           |
| **root-cause accuracy** | **71.7%** | — (no diagnosis) | — (no diagnosis) |

Reproduce it for free, no API key: `npm run bench -- --size 60 --seed 42 --mock`.

**Read the action-policy columns (the first six rows) honestly: it's close, not a clean win.**
The agent recovers one fewer case than the rules table but slightly more total rupees (a
higher-value mix), at a slightly higher escalation rate and a slower mean time to recovery. On a
templated corpus, a lookup table on `error_reason` is a genuinely strong baseline — that finding
from earlier rounds still holds, and we're not hiding it by only comparing to the weaker fixed
schedule.

**The row that isn't close is root-cause accuracy, and it's the one a lookup table cannot produce
at all.** `bench/rules-arm.ts` never diagnoses — it picks an action straight off `error_reason`
and has no concept of *why* the payment failed. The agent reaches the correct cause (matched
against the corpus's ground truth, independent of which action it then chose) on 71.7% of cases,
including the downtime-pair cases where the error code is actively misleading. That is the
capability an AI judgment claim has to rest on, and it's measured separately from — not folded
into — the money number, so one can't be used to launder the other.

The agent has 18 exceptions. 16 are cases the corpus marks unrecoverable by construction (8 risk
holds that must escalate by policy, 8 accounts that never fund) or self-flagged as risk — the
system correctly stops on all of them rather than guessing. Of the 2 real misses: one
(`cust_1058`, `card_expired`) is the model failing to conclude within its step budget and
degrading to a safe scheduled retry rather than a nudge — a model-availability cost, not a
reasoning error, and the exact case `hard_decline`'s new safety-gate veto exists to keep from
turning into a compliance problem even when it happens. The other (`cust_1004`, `payment_failed`)
is a genuine, transcript-visible misdiagnosis: the model called four tools, reasoned through a
soft-decline-vs-hard-decline split with 0.62 confidence, and picked wrong. Both are in
`bench/.cache/agent-turns-seed42-n60.json`. Neither is hidden from this table.

## Honest caveat

Razorpay test mode does not decline a card on demand, so the **incoming failure stream is
synthetic** (modeled from real error codes). The **recovery actions are real**: real Orders,
real Payment Links, real payment IDs. `recovered_paise` on the scoreboard is summed from three
clearly separated sources, never blended:

- **live** — a real Razorpay capture, `status == "captured"` on a real payment id.
- **bench** — ground-truth resolution for the evaluation (the order is still created for real;
  only the authorization result is simulated).
- **sim** — the demo's own "customer completes payment →" button
  (`POST /cases/:id/simulate-capture`). It builds a real HMAC-signed `payment.captured` webhook
  and runs it through the exact same handler a live Razorpay delivery hits — the signature
  verification, dedupe, settle and ledger code is genuinely exercised — but the event itself is
  self-signed, not sent by Razorpay. Its payment id is always prefixed `pay_sim_`, so it's never
  mistaken for a live capture in the ledger. This exists because Razorpay test mode has no
  on-demand way to complete a real capture headlessly; a real hosted-Checkout capture would need
  a public webhook endpoint, which a local buildathon demo doesn't have. The recovery engine is
  production-grade; this one button is honest theater standing in for a real customer's browser.

The agent's judgment and its execution are real; the incoming failures and the demo's own
capture button are simulated.

**One further simplification, stated plainly:** `RETRY_SCHEDULED`'s `atHoursFromNow` is real —
it decides the delay before the *next* attempt if this one fails — but the order for the current
attempt is created immediately either way, not deferred until that hour. A production version
would hold the charge itself until the scheduled time; this build always creates it now, since
holding it changes the worker's execution model in ways worth doing deliberately, not under a
buildathon deadline. Nothing here overstates it: the field genuinely governs re-attempt spacing,
it just doesn't yet govern the very first attempt's timing too.

## Architecture

```
api / worker / bench   →   agent · safety · execution · persistence   →   domain
```

- `src/domain/` — pure types and rules, zero I/O.
- `src/safety/safety-gate.ts` — a pure function, property-tested exhaustively; can only add
  caution. Five rules: risk hold, a hard-decline veto on any automatic reattempt (Visa/Mastercard
  both fine merchants for reattempting a decline that will not clear on its own), the attempt
  cap, the exposure cap, the confidence floor, and a cooldown.
- `src/agent/` — a hand-rolled bounded loop on the Vercel AI SDK (no agent framework). Bounded
  by a step budget, a wall-clock deadline, a forced conclusion on the last step, and
  degrade-to-safe: a missing / malformed / timed-out proposal returns a scheduled retry with a
  `null` root cause, never a guess and never a throw. The merchant's default-move-per-cause table
  lives behind a tool call (`get_recovery_playbook`), not in the system prompt — the model has to
  choose to consult it, so the investigation is real work, not retrieval.
- `src/execution/` — the only code that talks to Razorpay.
- `src/persistence/` — the only code that talks to Postgres. `recovery_events` and
  `razorpay_webhooks` are append-only **by database grant**, verified by a test that connects as
  the app role and expects `permission denied`.
- `src/worker/` — BullMQ: case → agent → gate → executor → record → schedule next.
- `bench/` — the three-arm evaluation (agent, fixed schedule, rules table).

## Run it

```bash
cp .env.example .env      # OPENROUTER_API_KEY + Razorpay test keys
docker compose up -d      # postgres :5434, redis :6381
npm install
./start.sh                # infra + schema + seed + API (:3000) and web (:5173)
npm test                  # 176 tests (needs docker compose up)

# the evaluation — agent, fixed schedule, and the rules table, on one batch
npx tsx --env-file=.env bench/run.ts --size 60        # records agent turns to bench/.cache
npx tsx --env-file=.env bench/run.ts --size 60 --mock # replays them in seconds, free

# seed the live demo queue
npx tsx --env-file=.env bench/seed-demo.ts
npx tsx --env-file=.env bench/smoke.ts                 # one real agent run against a known case
```

## Stack

Node 20+ / TypeScript (ESM) · Fastify · PostgreSQL 16 · Redis + BullMQ · a hand-rolled bounded
agent loop on the Vercel AI SDK (`ai` v7) · `@openrouter/ai-sdk-provider` · Zod at every
boundary · Razorpay test-mode APIs · React + Vite · Docker Compose · Vitest.

## What broke, and how we got out

The submission form's last question, kept as a live log rather than reconstructed at the end —
the full log is [`BREAKS.md`](./BREAKS.md). The short version: an earlier version of this project was
an authorization layer for agentic payments; we measured its AI component performing worse than
plain deterministic rules and pivoted to recovery. The bench went through two rounds of self-
audit before shipping: it was first found handing the agent its own ground truth through a
too-informative failure detail (fixed; the honest number dropped to 45.0% agent vs 46.7% fixed,
the agent *losing*), then found grading every action at the instant it was decided rather than
the hour it would settle, which punished the agent specifically for acting early and switching
rails (fixed; recovery rate rose to 65–68% on the same recorded turns, no re-run needed). A
follow-on tuning experiment then hit 100% of the corpus's own recoverable ceiling — a pre-declared
red flag — and was reverted in full rather than shipped. The rules-table arm above is the same
discipline applied one more time: run the honest deterministic baseline against the agent instead
of only against a strawman, and report what it actually shows.

A later hostile review found the live downtime tool matching on payment *method* instead of the
specific issuer — every card case read as a downtime match regardless of which bank, which meant
the audit trail carried confidently-worded but fabricated claims about named banks being down,
and the regression test written against it changed two variables at once so it passed anyway.
Fixed (issuer match and method-wide context are now separate fields), the corpus was rebuilt with
real ambiguity (a stated share of downtime-pair cases across both generic-decline reasons, and a
genuine history-trend split on `insufficient_funds`) instead of the answer table living in the
system prompt, and the agent's recovery rate moved from *below* the rules table to a real
near-parity on the money number plus a 71.7% root-cause accuracy neither baseline can produce at
all — see "The number" above for the honest table, misses included.
