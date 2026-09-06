# Running the Recovery Room

## First time on a fresh machine

```bash
cp .env.example .env          # fill in OPENROUTER_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) + Razorpay test keys
docker compose up -d          # postgres :5434, redis :6381
npm install
npm run db:schema             # applies db/schema.sql
```

## Every session - one command

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

- **Header scoreboard** - the batch result: agent ₹53,966 (56.7% recovered) vs the fixed
  day-1/3/5/7 schedule ₹31,480 (33.3%). See the README for the full three-arm table, including the
  rules-table baseline (which the agent does *not* cleanly beat on money), the root-cause accuracy
  row it cannot produce, and the `--blind-reason` experiment that isolates what the diagnosis is
  actually worth once the corpus's own answer-key label is hidden.
- **Case flow** - 34 recovered, 24 escalated, 2 written off, plus two fresh cases: `cust_live_demo`
  and `cust_over_cap`.
- **Waiting on you** - the risk-hold escalations, with working retry / send-link / write-off buttons.

Click any recovered case to see the agent's recorded reasoning, the tools it called, the root
cause, the safety gate's ruling, the attempt outcome, and the full audit tape.

## The live demo

Two fresh cases sit in `INCOMING`, each showing a different part of the safety story:

- **`cust_live_demo`** → **"work this case now"**. The agent runs for real: its reasoning
  streams token by token, it calls its tools, and it concludes with a proposal. Once a real order
  or payment link exists, **"Customer pays (Razorpay Checkout)"** opens Razorpay's real hosted
  widget against it : completing it fires a genuinely Razorpay-signed webhook (needs a public
  tunnel pointed at `/webhooks/razorpay` and registered in the Razorpay test-mode dashboard). No
  tunnel running, or want the offline fallback instead: **"Simulate payment (no real charge)"**
  builds a self-signed webhook through the exact same handler : signature verification, dedupe,
  settle and ledger code genuinely exercised, but the payment id is always prefixed `pay_sim_` so
  it's never mistaken for a live capture. See [`web/FRONTEND.md` → "Live vs recorded
  data"](./web/FRONTEND.md#live-vs-recorded-data--this-matters) for the full picture.
- **`cust_over_cap`** : a ₹6,499 case, over the ₹5,000 auto-recovery exposure cap. Whatever the
  agent proposes, the safety gate clamps it to `ESCALATE` before any Razorpay call is made. Worth
  running to see the gate actually bind, not just claim to.

Check `GET /model-health` (or the model line in the runtime config the UI reads from `/config`)
before recording a live run : the default model (`minimax/minimax-m3:free`) is free but degrades
on the majority of cases without the merchant playbook's timing hints (measured:
`AGENT_MODEL=minimax/minimax-m3:free npm run bench -- --size 60 --seed 42 --mock` — 86.7% degrade
rate, 8.3% root-cause accuracy on this corpus). For the model the headline eval actually uses:

```bash
AGENT_MODEL=google/gemini-3.6-flash npm run dev   # needs GOOGLE_GENERATIVE_AI_API_KEY, a few cents
```

Model spend for the whole server process is hard-capped by `AGENT_SESSION_CAP_USD` (default
$0.50).

## The evaluation

```bash
# always pin AGENT_MODEL on --mock : the cache is keyed by model, and the config default
# (minimax/minimax-m3:free) replays a much weaker recorded run without it, silently
AGENT_MODEL=google/gemini-3.6-flash npm run bench -- --size 60 --mock       # replays, ~1s, free
AGENT_MODEL=google/gemini-3.6-flash npm run bench -- --size 60 --cap-usd 5.00   # a real agent run

# --arm restricts which arm actually runs — the other two print as 0 in the same table, not
# because they lost, but because they never ran this time
npm run bench -- --arm rules --size 60 --mock   # just the rules-table baseline, no cache needed
AGENT_MODEL=google/gemini-3.6-flash npm run bench -- --size 60 --mock --blind-reason  # see README
```

The bare `--cap-usd` default (30 cents) is calibrated for the zero-cost model, not the headline
one : a real run on `google/gemini-3.6-flash` costs roughly $3 (450-490 model calls across 60
cases, measured), so pass `--cap-usd 5.00` or the run trips its own budget guard partway through.

`--mock` replays the agent's recorded turns from `bench/.cache/agent-turns-seed<N>-n60-<model>.json`
(`-blind.json` under `--blind-reason`) : the cache is keyed by model as well as seed and size, so a
different `AGENT_MODEL` needs its own recording first. Only the agent arm needs a cache; `fixed`
and `rules` are pure functions and run for free either way.

## Tests

```bash
npm test        # 233 tests; needs docker compose up
```
