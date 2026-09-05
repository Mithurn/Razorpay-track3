# Frontend — Recovery Room

The web UI (`web/`) is the Recovery Room: a real-time dashboard for watching payment cases move
through the recovery pipeline and inspecting what the agent decided and why.

For the product overview and backend architecture, see the [root README](../README.md) and
[`src/README.md`](../src/README.md).

---

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  TopBar  — live throughput metrics, evaluation scoreboard│
├────────────────┬────────────────────────────────────────┤
│                │  Stage header (queued / investigating / │
│  Sidebar       │  deciding / executing / recovered …)   │
│                ├────────────────────────────────────────┤
│  Case queue    │  LoopGraph                             │
│  Escalation    │  (agent stage flow, live progress)     │
│  queue         ├────────────────────────────────────────┤
│                │  ActivityStream                        │
│  ↓             │  (live agent reasoning, tool results)  │
│                ├────────────────────────────────────────┤
│  Select a      │  AttemptTimeline                       │
│  case to see   │  (attempt history for this case)       │
│  its detail    ├────────────────────────────────────────┤
│                │  CustomerPanel                         │
│                │  (customer context, case metadata)     │
│                ├────────────────────────────────────────┤
│                │  RazorpayCheckout (recovered cases)    │
│                │  Simulated capture button              │
└────────────────┴────────────────────────────────────────┘
```

---

## Components

### TopBar — `web/src/room/TopBar.tsx`

Live recovery metrics (pulled from `/api/room` SSE stream) and the evaluation scoreboard
(fetched from `/api/scoreboard`). The scoreboard shows the three-arm comparison (agent / fixed /
rules) from the most recent bench run stored in the database.

### Sidebar — `web/src/room/Sidebar.tsx`

Two queues: incoming cases waiting for recovery, and escalated cases waiting for a human
directive. Selecting a case loads its full detail into the main panel. The sidebar polls every 2
seconds and also updates on SSE events.

### LoopGraph — `web/src/loop/LoopGraph.tsx`

A stage-flow diagram showing where in the pipeline the selected case currently sits. Stages:
`INVESTIGATE → DIAGNOSE → GATE → EXECUTE → OUTCOME`. Each stage lights up as the case passes
through it. Powered by `useCaseLoopState` which derives the current stage from the event log.

### ActivityStream — `web/src/loop/ActivityStream.tsx`

The live agent reasoning stream. Tool calls and their results appear in real time as the agent
works, sourced from the SSE stream (`/api/stream/:caseId`). After the agent finishes, the full
tool-call trace is replayed from the event log so the same view works for historical cases.

For a case seeded from the recorded benchmark (`npm run seed:room`), the tool-call trace comes
from the stored cache replay — see **Live vs recorded data** below.

### AttemptTimeline — `web/src/loop/AttemptTimeline.tsx`

All attempts for the selected case in chronological order: action, status, gate rule (if clamped
or skipped), Razorpay reference, recovered amount. Shows the full history including re-attempts
after escalation resolution.

### CustomerPanel — `web/src/room/CustomerPanel.tsx`

Customer context: payment history summary, failure code, failure reason, amount, case lane,
time since failure. This is what the agent sees when it calls `get_customer_history`.

### RazorpayCheckout — `web/src/room/RazorpayCheckout.tsx`

Shown when a case's current attempt has a `PAYMENT_LINK` action. Embeds a real Razorpay
Checkout widget using the live payment link URL from the attempt row. Allows completing a
payment directly in the UI.

**This is a real Razorpay Checkout in test mode.** Payments made here go through the Razorpay
test-mode flow (Razorpay's own test card numbers apply). The capture webhook comes back to the
server and settles the case in the database.

### Simulate capture button

Shown next to `RETRY_SCHEDULED` attempts. Calls `POST /api/cases/:id/simulate-capture`, which
injects a synthetic `payment.captured` webhook with a `pay_sim_` prefixed payment ID.

**This does not touch Razorpay.** The server generates a fake payment ID
(`pay_sim_<uuid>`), injects it through the same webhook handler as a real capture, and marks the
resulting event as `simulated: true` in the audit log. The UI displays a "Simulated" label on
recoveries settled this way. See `src/domain/simulated-payment.ts` and
`src/execution/webhook-handler.ts` lines 135–141.

---

## SSE stream

The UI connects to `/api/room` (room-wide events) and `/api/stream/:caseId` (per-case events)
via Server-Sent Events. Both streams replay the event log from the beginning on connect, then
follow live updates. `web/src/loop/reconnectingStream.ts` handles reconnection with backoff.

There is no WebSocket. SSE is enough for a read-only event feed.

---

## Live vs recorded data — this matters

The Recovery Room can be seeded two ways, and they look identical in the UI. Knowing which you
are looking at matters for evaluating claims about the system.

### Seeded from the recorded benchmark (`npm run seed:room`)

**File:** `bench/seed-room.ts`

This replays the recorded benchmark runs into the live database. The agent turns (proposals + full
tool-call traces) come from `bench/.cache/`, not from a live model call. The cases, attempts, and
event logs are written to real Postgres rows — the UI reads real API endpoints — but the
underlying data is the pre-recorded evaluation, not a fresh agent run.

**What is live in this mode:**

- The database, API server, and SSE streams are live
- The case, attempt, and event data is real Postgres rows
- Navigation, filtering, and the activity stream replay all work normally

**What is not live:**

- No model was called to produce these results
- No Razorpay API was called
- The `simulated: true` flag is set on captures settled via the seed

The scoreboard in the TopBar reflects the bench run stored in the database — those numbers are
the same published evaluation numbers.

### Live recovery from a real webhook

Run the server (`npm run dev`) and trigger a real `payment.failed` webhook (or use the Razorpay
test-mode dashboard to fire one). The agent runs live against the real model, calls the real
Razorpay downtime API, and the activity stream shows tool calls happening in real time as they
are emitted.

**What is live in this mode:**

- Every model call is real (charged against your API key)
- Bank downtime data comes from the live Razorpay API
- Razorpay execution uses real test-mode orders and payment links
- The RazorpayCheckout widget shows a real payment link you can complete

**What is not live:**

- The corpus is still synthetic — there is no real merchant receiving these payments
- Customer history comes from the seeded database, not a real payment history feed

---

## Evaluation scoreboard

The TopBar scoreboard reads `/api/scoreboard`, which returns the most recent three-arm bench
results stored in `recovery_runs`. After `npm run seed:room` this shows the seed 42 evaluation
results. After a live bench run (`npm run bench`) it shows whatever the most recent run produced.

The scoreboard is **not** updated in real time as cases recover. It reflects recorded bench runs,
not the cases currently in the queue. This distinction is intentional — mixing live case
recoveries with bench evaluation would conflate controlled evaluation with operational results.

---

## Tech

- React 18, TypeScript, Vite
- No component framework (Tailwind for utility classes, hand-written layout)
- `useRoomStream` — SSE hook for real-time room state
- `useLiveRun` — per-case agent trace hook
- `useCaseLoopState` — derives `StageId` from raw events for the LoopGraph
- `reconnectingStream` — SSE reconnection with exponential backoff

Tests in `web/src/loop/` cover the activity derivation logic (`activities.test.ts`),
loop state transitions (`loop-state.test.ts`), and tool line formatting (`toolLine.test.ts`).
