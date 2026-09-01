# Recovery Room

An AI agent that recovers failed payments. Built for the **Razorpay AI Buildathon — Track 3
(AI Revenue Recovery).**

> Status: scaffold. See `context/PROJECT.md` for the full brief and the 3-day plan.

## The problem

Every recurring merchant on Razorpay loses 5–15% of revenue to *involuntary* churn — payments
that fail for **fixable** reasons (expired card, insufficient funds at the wrong time, bank
downtime, soft decline). Today recovery is a dumb fixed retry schedule or a human. Both leave
money on the table and annoy customers who would have paid anyway.

## What it does

A failed payment enters as a case. A bounded AI agent investigates it — pulls the customer's
payment history, checks whether the issuing bank is in a downtime window, looks at what worked
for similar cases — reasons out loud (you watch it stream), and proposes a recovery move: retry
now, retry at a better time, send a payment link on a different rail, nudge the customer, or
escalate to a human. A deterministic safety gate can only make it *more* cautious (it enforces
attempt caps, a rupee exposure limit, cooldowns, and idempotency — the LLM has no path to move
money past those). The executor performs the move exactly once and reconciles against Razorpay
if a call is ambiguous, so it never double-charges. If the attempt fails, the agent gets the
result and tries something else.

You watch all of it happen: cards flowing through lanes, the agent's reasoning streaming
token-by-token, escalations landing in a "waiting on you" rail.

## The number

Two arms over a synthetic batch of ~120 failed payments with realistic Razorpay error codes and
ground-truth recoverability: a **fixed retry schedule** (day 1/3/5/7) vs **the agent**. We
report ₹ recovered, recovery rate, attempts per recovery, over-nudge rate (customers contacted
who would have self-recovered), escalation rate, and an honest exception list of what it could
not recover and why.

## Honest caveat

Razorpay test mode does not decline a card on demand, so the *incoming failure stream* is
synthetic (modeled from real error codes). The *recovery actions* are real test-mode API calls —
real Orders, real Payment Links, real captures, real payment IDs. The agent's judgment and its
execution are real; the failures are simulated.

## Run it

```bash
cp .env.example .env      # fill in GEMINI_API_KEY and the Razorpay test keys
docker compose up -d      # postgres :5433, redis :6380
npm install
npm run db:schema
npm run dev                # API + recovery worker
npm run web                # the Recovery Room UI
npm run bench               # the two-arm scoreboard
```

## Stack

Node + TypeScript · Fastify · PostgreSQL (append-only audit ledger) · Redis + BullMQ · Mastra +
Gemini 2.5 Flash · React + Vite · Docker Compose.

## History

This project was pivoted from **Aegis**, an authorization/trust layer for agentic payments.
Aegis was solid engineering aimed at the wrong problem — authorization is deterministic, so the
AI had no real job. Payment recovery is where an agent genuinely earns its place. The full story
is our "what broke, and how you got out." Aegis is preserved on a separate branch.
