# Running the Recovery Room

## First time on a fresh machine

```bash
cp .env.example .env          # fill in OPENROUTER_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) + Razorpay test keys
docker compose up -d          # postgres :5434, redis :6381
npm install
npm run db:schema             # applies db/schema.sql
```

## Every session — one command

```bash
./start.sh
```

Brings up Postgres + Redis, applies the schema, seeds the room from the recorded 60-case run
(free, no model calls), and starts the API (:3000) and the web app (:5173). Ctrl-C stops it.

`./start.sh --bare` skips the seed and keeps whatever is already in the database.

Or run the pieces yourself:

```bash
docker compose up -d
npm run db:schema
npm run seed:room
npm run dev
```

Open **http://localhost:5173**. You'll see:

- **Header scoreboard** — the batch result: agent ₹62,459 (68% recovered, 28% to a human) vs the
  fixed day-1/3/5/7 schedule ₹42,972 (47%, 53% to a human). See the README for the full
  three-arm table, including the rules-table baseline that beats both.
- **Case flow** — 41 recovered, 17 escalated, 2 written off, plus two fresh cases:
  `cust_live_demo` and `cust_over_cap`.
- **Waiting on you** — the risk-hold escalations, with working retry / send-link / write-off buttons.

Click any recovered case to see the agent's recorded reasoning, the tools it called, the root
cause, the safety gate's ruling, the attempt outcome, and the full audit tape.

## The live demo

Two fresh cases sit in `INCOMING`, each showing a different part of the safety story:

- **`cust_live_demo`** → **"work this case now"**. The agent runs for real: its reasoning
  streams token by token, it calls its tools, and it concludes with a proposal. Then click
  **"customer completes payment →"** — that fires a real HMAC-signed webhook through the same
  handler a live Razorpay delivery hits, and the case flips to **RECOVERED**. This capture is
  self-signed, not sent by Razorpay — see the README's Honest caveat for exactly what that does
  and doesn't prove, and why.
- **`cust_over_cap`** — a ₹6,499 case, over the ₹5,000 auto-recovery exposure cap. Whatever the
  agent proposes, the safety gate clamps it to `ESCALATE` before any Razorpay call is made. Worth
  running to see the gate actually bind, not just claim to.

Check `GET /model-health` (or the model line in the runtime config the UI reads from `/config`)
before recording a live run — the default model (`minimax/minimax-m3:free`) is free but can be
rate-limited or produce a malformed proposal mid-run, in which case the agent degrades to a safe
scheduled retry rather than crashing. For a run that reliably concludes:

```bash
AGENT_MODEL=google/gemini-2.5-flash npm run dev   # needs GOOGLE_GENERATIVE_AI_API_KEY, a few cents
```

Model spend for the whole server process is hard-capped by `AGENT_SESSION_CAP_USD` (default
$0.50).

## The evaluation

```bash
npm run bench -- --size 60 --mock     # replays the recorded run, ~1s, free — agent, fixed, rules
npm run bench -- --size 60            # a real agent run (guarded by --cap-usd, default $0.30)
npm run bench -- --arm rules --size 60 --mock   # just the rules-table baseline, no cache needed
```

`--mock` replays the agent's recorded turns from `bench/.cache/agent-turns-seed42-n60.json` —
only the agent arm needs that cache; `fixed` and `rules` are pure functions and run for free
either way. There's no `n120` cache checked in, so `--size` other than 60 needs a real run first
(costs a small amount against `--cap-usd`, or is free with `--arm fixed`/`--arm rules`).

## Tests

```bash
npm test        # 112 tests; needs docker compose up
```
