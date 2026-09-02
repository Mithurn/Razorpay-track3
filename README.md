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
ground-truth recoverability (44 of 60 recoverable by construction — 16 are lost accounts and
risk holds, unrecoverable by any arm), run through three arms on the same gate, executor and
ledger with only the brain swapped:

|                    | agent    | fixed    | rules table |
|--------------------|----------|----------|-------------|
| recovered          | 41 / 60  | 28 / 60  | 43 / 60     |
| recovery rate      | 68.3%    | 46.7%    | 71.7%       |
| ₹ recovered        | ₹62,459  | ₹42,972  | ₹64,457     |
| escalation rate    | 28.3%    | 53.3%    | 28.3%       |
| mean attempts/rec  | 1.49     | 1.32     | 1.00        |
| mean hours to rec  | 36.7     | 41.1     | 28.6        |

Reproduce it for free, no API key: `npm run bench -- --size 60 --seed 42 --mock`.

**The third column is the finding.** `bench/rules-arm.ts` is the agent's own system-prompt
playbook — "card_expired → nudge the customer," "payment_risk_check_failed → escalate," and so
on — transcribed into a 6-line `switch` on `error_reason`. No model, no tools, no re-planning,
₹0. It beats the LLM. On a 7-template corpus, a table built from the same 7 lines the agent's
prompt already contains wins, because there's nothing left for judgment to add.

The one case in sixty that separates them: a `payment_failed` decline whose issuer is, this
time, actually in a live downtime window — the same code, a different cause. The table can't
see that; it only reads the code, and loses the case (escalates). The agent recovers it, but not
on the first move: its own `get_similar_resolved_cases` retrieval, trained on a corpus where
every other `payment_failed` case recovers via a payment link, twice talked it out of the live
downtime signal it had already found, before a third failed attempt forced it back. The
transcript is in `bench/.cache/agent-turns-seed42-n60.json` under `cust_1032`. n=1 is an
existence proof, not a result — it's the honest size of the evidence a bounded corpus and a
₹100 budget buy, and it's also evidence our own retrieval tool can mislead the agent on a
templated eval, which is worth knowing regardless of the scoreboard.

The agent has 19 exceptions; 16 are unrecoverable by construction (risk holds, dead accounts) —
the rules table shares exactly these 16 misses. The agent's other 3 exceptions
(`insufficient_funds`, "funds arrive by day 3") are recoverable on timing alone: both the fixed
schedule and the rules table get all three, and the agent escalates all three instead — a real
gap, not hidden here.

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

## Architecture

```
api / worker / bench   →   agent · safety · execution · persistence   →   domain
```

- `src/domain/` — pure types and rules, zero I/O.
- `src/safety/safety-gate.ts` — a pure function, property-tested exhaustively; can only add
  caution.
- `src/agent/` — a hand-rolled bounded loop on the Vercel AI SDK (no agent framework). Bounded
  by a step budget, a wall-clock deadline, a forced conclusion on the last step, and
  degrade-to-safe: a missing / malformed / timed-out proposal returns a scheduled retry with a
  `null` root cause, never a guess and never a throw.
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
npm test                  # 112 tests (needs docker compose up)

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
the full log is `context/BREAKS.md`. The short version: an earlier version of this project was
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
