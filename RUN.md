# Running RecoveryOps

---

## First time setup

```bash
cp .env.example .env
# Fill in: OPENROUTER_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY)
#          RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (test mode keys)
#          RAZORPAY_WEBHOOK_SECRET

docker compose up -d      # Postgres :5434, Redis :6381
npm install
npm run db:schema         # applies db/schema.sql + role grants
```

## Every session — one command

```bash
./start.sh
```

Brings up Postgres + Redis, applies the schema, seeds the room from the recorded 60-case evaluation (free, no model calls), and starts the API (:3000) and web app (:5173). Ctrl-C stops everything.

`./start.sh --bare` skips seeding and keeps whatever is already in the database.

Open **http://localhost:5173**.

---

## What you'll see

- **Header scoreboard** — agent 56.7% (₹53,966) vs fixed 33.3% (₹31,480) vs rules 60.0% (₹56,464). See [`README.md → Evaluation`](./README.md#evaluation) for the full table and what the result actually means.
- **Case flow** — 34 recovered, 24 escalated, 2 written off, plus two fresh cases for the demo.
- **Escalation queue** — risk-hold cases waiting for a human directive. The Retry / Send link / Send nudge / Write off buttons are live.

Click any recovered case to see the agent's recorded reasoning, tool calls, safety gate ruling, and the full audit tape. Use the **Audit log** button to see every raw event including suppressed types.

---

## The two demo cases

Two fresh cases sit in `INCOMING`, each showing a different safety story:

**`cust_live_demo`** — click "Work this case now." The agent runs for real: reasoning streams token by token, tools fire, and it concludes with a proposal. Once an order or payment link exists:
- **"Customer pays (Razorpay Checkout)"** — opens Razorpay's real hosted widget. Completing it fires a genuine Razorpay-signed webhook (requires a public tunnel pointed at `/webhooks/razorpay`, registered in the Razorpay test-mode dashboard).
- **"Simulate payment (no real charge)"** — injects a self-signed webhook through the same handler. Signature verification, dedupe, and settle code run genuinely; the payment ID is always prefixed `pay_sim_`.

**`cust_over_cap`** — ₹6,499 case, over the ₹5,000 auto-recovery exposure cap. Whatever the agent proposes, the safety gate clamps it to `ESCALATE`. Run this to see the gate actually bind, not just claim to.

---

## Model selection

Check the model before running a live demo. The default (`minimax/minimax-m3:free`) degrades on the majority of cases without the playbook's timing hints (measured: 86.7% degrade rate, 8.3% root-cause accuracy on this corpus). For the model the published evaluation uses:

```bash
AGENT_MODEL=google/gemini-3.6-flash npm run dev   # needs GOOGLE_GENERATIVE_AI_API_KEY
```

Model spend is hard-capped by `AGENT_SESSION_CAP_USD` (default $0.50).

---

## Reproduce the evaluation

```bash
# Replay all three arms — free, ~1s (uses committed cache files)
AGENT_MODEL=google/gemini-3.6-flash npm run bench -- --size 60 --seed 42 --mock

# Blind-reason control
AGENT_MODEL=google/gemini-3.6-flash npm run bench -- --size 60 --seed 42 --mock --blind-reason

# Live agent run (~$3, ~7 min — needs API key + DB)
AGENT_MODEL=google/gemini-3.6-flash npm run bench -- --size 60 --seed 1 --cap-usd 5.00

# Single arm only
npm run bench -- --arm rules --size 60 --mock
```

> Always pass `AGENT_MODEL` with `--mock`. The cache is keyed by model ID — without it, the config default (`minimax/minimax-m3:free`) replays a weaker recording silently.

A live run on `google/gemini-3.6-flash` costs ~$3 (450–490 model calls across 60 cases), so pass `--cap-usd 5.00` or the budget guard trips partway through.

---

## Utilities

```bash
npm run decision-table    # agent turn breakdown by root cause × action from cached runs
npm run verify-audit      # prove UPDATE/DELETE on recovery_events is refused at DB level
npm run explain -- <id>   # print full ordered audit tape for a case (all event types)
npm test                  # 245 tests (needs docker compose up for integration tests)
npm run test:unit         # 109 unit tests, zero services, ~2s
```
