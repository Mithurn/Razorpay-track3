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
it enforces an attempt cap, a rupee exposure limit, a cooldown, and a mandatory escalation on
risk-flagged payments. The LLM has no path to move money past a cap, past the attempt limit, or
twice.

The **executor** performs the move against Razorpay test mode exactly once (one idempotency key
per attempt), and on an ambiguous response (5xx / timeout) it re-checks before concluding — so
it never double-charges. If the attempt fails, the result goes back to the agent and it
re-plans.

You watch all of it: cards flowing through lanes, the agent's reasoning streaming token by
token, escalations landing in a "waiting on you" rail, a scoreboard proving it beats the fixed
schedule.

## The number

Two arms over a synthetic batch of ~120 failed payments, using only Razorpay's own `error_reason`
values and ground-truth recoverability: a **fixed retry schedule** (day 1/3/5/7) vs **the
agent**, both running through the same gate, executor and ledger with only the brain swapped.
Reported: ₹ recovered, recovery rate, mean attempts per recovery, mean time to recovery,
over-nudge rate (customers contacted who would have self-recovered), escalation rate, and an
honest exception list of what it could not recover and why.

The batch includes **matched pairs**: a generic decline whose issuer is in a live downtime
window, next to an identical case whose issuer is not — the fixed schedule cannot tell them
apart and gets one wrong.

## Honest caveat

Razorpay test mode does not decline a card on demand, so the **incoming failure stream is
synthetic** (modeled from real error codes). The **recovery actions are real**: real Orders,
real Payment Links, real payment IDs. `recovered_paise` on the scoreboard is summed from two
clearly separated sources, never blended:

- **live** — real Razorpay captures, `status == "captured"` on a real payment id.
- **bench** — ground-truth resolution (the order is still created for real; only the
  authorization result is simulated).

The agent's judgment and its execution are real; the failures are simulated.

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
- `bench/` — the two-arm evaluation.

## Run it

```bash
cp .env.example .env      # OPENROUTER_API_KEY + Razorpay test keys
docker compose up -d      # postgres :5434, redis :6381
npm install
./start.sh                # infra + schema + seed + API (:3000) and web (:5173)
npm test                  # 82 tests (needs docker compose up)

# the evaluation
npx tsx --env-file=.env bench/run.ts --size 120        # records agent turns to bench/.cache
npx tsx --env-file=.env bench/run.ts --size 120 --mock # replays them in seconds

# seed the live demo queue
npx tsx --env-file=.env bench/seed-demo.ts
npx tsx --env-file=.env bench/smoke.ts                 # one real agent run against a known case
```

## Stack

Node 20+ / TypeScript (ESM) · Fastify · PostgreSQL 16 · Redis + BullMQ · a hand-rolled bounded
agent loop on the Vercel AI SDK (`ai` v7) · `@openrouter/ai-sdk-provider` · Zod at every
boundary · Razorpay test-mode APIs · React + Vite · Docker Compose · Vitest.

## What broke, and how we got out

The submission form's last question, kept as a live log rather than reconstructed at the end.
The short version: an earlier version of this project was an authorization layer for agentic
payments; we measured its AI component performing worse than plain deterministic rules and
pivoted to recovery, where reading intent and timing from messy history is exactly what a rule
cannot do. Along the way the model named in the plan turned out to be retired, the API key was
quota-capped, the safety gate had a compliance gap the property test caught on its first run,
and the anti-double-charge design rested on two false assumptions about Razorpay's API that only
surfaced by probing it live.
