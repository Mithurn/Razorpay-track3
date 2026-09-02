# Running the Recovery Room

## First time on a fresh machine

```bash
cp .env.example .env          # fill in OPENROUTER_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) + Razorpay test keys
docker compose up -d          # postgres :5434, redis :6381
npm install
npm run db:schema             # applies db/schema.sql
```

## Every session

```bash
docker compose up -d          # if the containers aren't already up
npm run seed:room             # fills the room from the recorded 60-case run (free, no model calls)
npm run dev                   # starts the API (:3000) and the web app (:5173) together
```

Open **http://localhost:5173**. You'll see:

- **Header scoreboard** — the batch result: agent ₹65,956 (73% recovered, 13% to a human) vs the
  fixed day-1/3/5/7 schedule ₹42,972 (47%, 53% to a human).
- **Case flow** — 44 recovered, 8 escalated, 8 written off, plus one fresh case `cust_live_demo`.
- **Waiting on you** — the 8 risk-hold escalations, with working retry / send-link / write-off buttons.

Click any recovered case to see the agent's recorded reasoning, the tools it called, the root
cause, the safety gate's ruling, the attempt outcome, and the full audit tape.

## The live demo

Click **`cust_live_demo`** → **"work this case now"**. The agent runs for real: its reasoning
streams token by token, it calls its tools, and it concludes with a proposal. Then click
**"customer completes payment →"** — that fires a real signed Razorpay webhook through the same
handler a live delivery hits, and the case flips to **RECOVERED** with a real ₹1,499 credit.

For reliable live runs use the Gemini model (it always concludes; the free OpenRouter model can
be rate-limited mid-run):

```bash
AGENT_MODEL=google/gemini-2.5-flash npm run dev
```

Model spend for the whole server process is hard-capped by `AGENT_SESSION_CAP_USD` (default
$0.50). The default model (`minimax/minimax-m3:free`) costs nothing.

## The evaluation

```bash
npm run bench -- --size 120 --mock    # replays the recorded run, ~2s, free
npm run bench -- --size 60            # a real run (guarded by --cap-usd, default $0.30)
```

## Tests

```bash
npm test        # 82 tests; needs docker compose up
```
