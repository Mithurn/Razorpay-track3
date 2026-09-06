# Frontend — Recovery Room

The web UI is the Recovery Room: a real-time dashboard for watching payment cases move through the recovery pipeline and inspecting what the agent decided and why.

For the product overview see the [root README](../README.md). For the backend see [`src/BACKEND.md`](../src/BACKEND.md).

---

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  TopBar  — live throughput metrics + evaluation scores  │
├────────────────┬────────────────────────────────────────┤
│                │  Stage header (status indicator)        │
│  Sidebar       ├────────────────────────────────────────┤
│                │  ActivityStream (live agent reasoning)  │
│  Case queue    ├────────────────────────────────────────┤
│  Escalation    │  LoopGraph (stage flow diagram)         │
│  queue         ├────────────────────────────────────────┤
│                │  AttemptTimeline (all attempts)         │
│                ├────────────────────────────────────────┤
│                │  CustomerPanel (case context)           │
│                ├────────────────────────────────────────┤
│                │  RazorpayCheckout / Simulate capture   │
└────────────────┴────────────────────────────────────────┘
```

---

## Components

| Component | File | What it shows |
|-----------|------|---------------|
| TopBar | `room/TopBar.tsx` | Live recovery metrics (SSE) + three-arm scoreboard (`/api/scoreboard`) |
| Sidebar | `room/Sidebar.tsx` | Case queue + escalation queue; selects a case for detail view |
| ActivityStream | `loop/ActivityStream.tsx` | Tool calls, gate decisions, and outcomes — live during agent run, replayed from event log after |
| LoopGraph | `loop/LoopGraph.tsx` | Stage-flow diagram: INVESTIGATE → DIAGNOSE → GATE → EXECUTE → OUTCOME |
| AttemptTimeline | `loop/AttemptTimeline.tsx` | All attempts: action, status, gate rule (if clamped), Razorpay ref, recovered amount |
| CustomerPanel | `room/CustomerPanel.tsx` | Payment history, failure code, amount — what the agent sees from `get_customer_payment_history` |
| RazorpayCheckout | `room/RazorpayCheckout.tsx` | Real Razorpay Checkout widget for `PAYMENT_LINK` attempts (test mode) |
| AuditLog | `loop/AuditLog.tsx` | Raw event table — every event including those the ActivityStream suppresses (HUMAN_DIRECTIVE, AUDIT_GAP) |

### Escalation queue

The sidebar escalation queue shows cases awaiting a human directive. Each card has:
- **Retry** — retry with the agent's original proposed action
- **Send link** — redirect to PAYMENT_LINK
- **Send nudge** — redirect to CUSTOMER_NUDGE
- **Write off** — close the case
- **Note field** — operator note forwarded to the `/decision` endpoint (max 500 chars)

### Simulate capture

Shown next to `RETRY_SCHEDULED` attempts. Calls `POST /api/cases/:id/simulate-capture`, which injects a synthetic `payment.captured` webhook through the same handler as a real capture. The payment ID is always prefixed `pay_sim_` and the event is flagged `simulated: true` in the audit log. The backend separates simulated money from live money in `recoveredSimulatedPaise` vs `recoveredLivePaise`; the TopBar labels them accordingly.

---

## SSE streams

| Stream | Purpose |
|--------|---------|
| `/api/stream` | Room-wide events — metrics, case lane changes |
| `/api/cases/:id/stream` | Per-case events — agent reasoning, tool results, gate decisions, outcomes |

Neither stream replays history. Each sends an `open` frame, then one snapshot (room metrics or current lane), then only events from that point forward. A client fetches full history over HTTP first (`GET /cases/:id`) and treats the stream as the live tail.

`web/src/loop/reconnectingStream.ts` handles reconnection with exponential backoff. No WebSocket — SSE is enough for a read-only event feed.

---

## Live vs recorded data

The Recovery Room looks identical whether it's showing pre-recorded or live data. Knowing which matters.

### Seeded from bench (`npm run seed:room`)

Replays the recorded 60-case evaluation into the live database. Agent turns (proposals + tool-call traces) come from `bench/.cache/` — no model was called to produce them, no Razorpay API was called.

**What is live:** database, API server, SSE streams, navigation, event replay.
**What is not live:** the underlying data is the pre-recorded evaluation. Captures are flagged `simulated: true`.

### Live recovery from a real webhook

Run `npm run dev` and trigger a `payment.failed` webhook. The agent runs against the real model, calls the real Razorpay downtime API, and the ActivityStream shows tool calls happening in real time.

**What is live:** every model call (charged against your API key), bank downtime data, Razorpay test-mode orders and payment links, RazorpayCheckout widget.
**What is not live:** customer history comes from the seeded database; the corpus is synthetic.

---

## Evaluation scoreboard

The TopBar scoreboard reads `/api/scoreboard` — the most recent three-arm bench results from `recovery_runs`. After `npm run seed:room` it shows seed 42 results. After a live bench run it shows whatever the most recent run produced.

The scoreboard is **not** updated in real time as cases recover. It reflects recorded bench runs, not the live queue — mixing the two would conflate controlled evaluation with operational results.

---

## Tech

- React 19, TypeScript, Vite
- No component framework, no CSS framework — hand-written CSS
- `useRoomStream` — SSE hook for real-time room state
- `useLiveRun` — per-case agent trace hook
- `useCaseLoopState` — derives `StageId` from raw events for the LoopGraph
- `reconnectingStream` — SSE reconnection with exponential backoff

Tests in `web/src/loop/` cover activity derivation (`activities.test.ts`), loop state transitions (`loop-state.test.ts`), and tool line formatting (`toolLine.test.ts`).
