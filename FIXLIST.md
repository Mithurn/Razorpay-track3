# Fix list — submission readiness

Work through P0 → P1 → P2 in order. Do not skip items. Do not push or commit unless
separately instructed. After each item, verify with the stated acceptance test.
Run `npm run typecheck` and the full test suite before declaring any item done.
Add a BREAKS.md entry for anything that breaks while fixing.

## P0 — submission-blocking

### 1. README.md:88 — false claim "97–98% of what's genuinely recoverable"
The seed-42 corpus ceiling is 44/60 recoverable cases, ₹1,08,456. Against that:
- agent: 33/44 cases = 75% of ceiling; ₹51,967 = 47.9% of ceiling rupees
- fixed: 20/44 = 45.5%; ₹31,480 = 29.0%
- rules: 36/44 = 81.8%; ₹56,464 = 52.1%

Replace the sentence with the true ceiling math, denominator stated explicitly. If some
cases are excluded by design (e.g. hard-decline write-offs excluded from "recoverable"),
state that exclusion and recompute — do not leave the 97–98% number in any form unless a
stated, reproducible denominator supports it.

Accept: the sentence and the table cannot be used to contradict each other by a hostile
reader with a calculator.

### 2. Disclose the similar-cases timing echo
`get_similar_resolved_cases` (src/persistence/case-repository.ts) returns
`hoursToResolution` for same-run, earlier-resolved siblings. On the templated corpus
(9 cases per template, deterministic per-template recovery hours: 24h and 6h), late-batch
cases can read their template's exact recovery hour. This is defensible in production
terms but is an agent-arm-only signal on a templated corpus.

- Add an explicit paragraph to README under the bench/eval section.
- Add a BREAKS.md entry (expected: no ground-truth signal in tools; actual: template
  timing echo exists; safeguard: disclosure + corpus diversification as future work).

Accept: someone who greps the tool code and the corpus can find no undisclosed signal.

### 3. Push the branch
The working tree is ~16 commits ahead of origin/room-redesign and ~20 ahead of origin/main.
The public repo currently shows the pre-fix inflated-numbers state. Push after ALL P0 items
(1-4) are committed, so the public repo never sees a half-corrected README. (Only on
explicit user instruction.)

### 4. First-attempt decision table in README
Add a table: first-attempt proposed action (retry / payment link / nudge / write-off /
escalate) × ground-truth correct action, with per-cell counts, for the agent arm.
FIRST verify the recorded run actually captures the first-attempt proposed action per case
(attempt rows in the bench output / DB). If it does not, CUT this item and say so — do not
re-run the bench to generate it. Deriving counts from the recorded run is allowed and
encouraged; inventing or re-running is not.

Accept: table present in README, numbers reproducible from the recorded run — or the item
is cut with a one-line note to the user.

## P1 — reliability holes (fix + test each)

### 5. Crash between claim() and perform() stalls the attempt forever
worker/pipeline.ts (~146-155) + execution/attempt-executor.ts: after claim() succeeds but
before the Razorpay order/link is created, a crash leaves a PENDING attempt that
reconciliation resolves as "pending" forever. The sweep re-enqueues into the same dead end.
Fix: a re-perform path for a claimed-but-never-performed attempt (e.g. claim carries a
"created order?" marker, or re-check on the idempotency key then re-perform), or the sweep
re-performs claims older than a threshold whose gateway lookup returns nothing. Crash safety
against double-charge must be preserved — re-perform only when the gateway lookup confirms
no order exists for the key.

Accept: test that kills the process between claim and perform (or simulates it) results in
exactly one eventual Razorpay call, not zero, not two.

### 6. Redelivered-webhook crash window → double-charge
worker/webhook-handler.ts (~148-162): settleRecovered and moveLane are separate
transactions. Crash between them → redelivery hits the "attempt already RECOVERED →
duplicate" branch, lane never moves, advance() sees no parked attempt and runs a fresh
investigation on an already-recovered case; gate never checks recovered money, so a second
order can be created. Fix: on redelivery of an already-settled event, still attempt the
lane move (idempotent), and/or include "case already has recovered money settled" in the
gate context as an auto-ESCALATE.

Accept: test — settle commits, lane move crashes, redelivered event → no new agent run, no
new Razorpay call.

### 7. BullMQ jobId dedupe race drops legitimate turns
worker/queue.ts (~22, 34): jobId: caseId + removeOnComplete: true. An enqueue arriving
while a job for the same case is active is discarded; when the active job completes and is
removed, nothing is queued and the case stalls (possibly forever for a RETRY_SCHEDULED
reschedule). Fix options: removeOnComplete false with a reaper, or re-enqueue check at job
end ("was a newer request dropped while I ran?"), or per-request jobIds with dedupe in the
worker. Pick the smallest correct one.

Accept: test — enqueue during active job is not lost; the case's next turn runs.

### 8. Webhook capture amount not validated
webhook-handler.ts (~149): credits captured.amount without cross-checking against the
case amount. Validate captured amount against the attempt's expected amount before
crediting; mismatch → park for reconciliation/escalate, never silently credit.

Accept: test — webhook with mismatched amount does not credit recovered_paise.

### 9. TOOL_RESULT append failures are swallowed
worker/recovery-worker.ts (~20-23): persistToolEvent catches and console.errors. A failed
append means the live stream and the audit ledger disagree, silently. Fix: record the loss
(e.g. a dedicated AUDIT_GAP event or a durable counter) — never leave the ledger silently
incomplete.

### 10. Two cheap server hardenings (auth intentionally NOT added to read/stream routes)
- /cases/:id/audit/verify (routes.ts ~197) runs an UPDATE probe unauthenticated and leaks
  the DB role name → put behind the existing requireAuth.
- Server binds 0.0.0.0 (main.ts ~134) → default to localhost unless explicitly configured
  otherwise (HOST env override stays fine).
- Read/stream routes (/stream, /cases/:id, /events) stay open on purpose: synthetic data,
  test mode, and the live demo should work without tokens.

Accept: audit/verify returns 401 without the token; server bound to localhost by default;
demo UI works unchanged.

## P2 — polish / honesty

### 11. Stop registry is per-process in-memory
Do not build Redis-backed stops now. Document the limitation explicitly in README
(single-node demo brake; multi-node needs shared state). One honest paragraph.

### 12. Nudge outcomes recorded as FAILED
execution/attempt-executor.ts (~159-162): a successfully queued nudge is recorded as
FAILED. Introduce a DELIVERED/COMPLETED status for nudges so attempt-outcome metrics
aren't polluted. BEFORE changing the status string, check bench/metrics.ts and any
metrics queries do not classify outcomes by status string — if they do, update them in
the same commit so future runs' metrics don't silently diverge from the published ones.

### 13. Mock cache staleness surface
bench cache key (bench/run.ts ~49) lacks any prompt/corpus hash; an edit to the prompt
silently replays stale turns. Fix: README disclosure only, in the same section as the
model-pinning trap. Do NOT add a prompt/corpus hash to the cache key — it would orphan the
existing recording, force a re-record (forbidden by the rules below), and produce new
numbers. The disclosure is mandatory; the hash is off the table for this submission.

### 14. bench/run.ts exception-list retarget
`exceptionList(results.agent ?? results.fixed ?? [])` silently changes semantics when the
agent arm is missing. Make it explicit per-arm or throw.

### 15. README tighten + repo hygiene
- README is 348 dense lines. Restructure: headline numbers + table up top, decision table,
  safety story (5 lines), what's real/what's stubbed, then depth sections. Cut prose, not
  honesty.
- Remove leftover `.mastra/` from .gitignore.
- Optionally add `!README-screenshots/*.png` exception if screenshots are wanted.

### 16. Comment trim + AI-smell pass (src/ only)
Current state: ~358 comment lines across ~3,647 src lines (~10%). Heaviest files:
src/worker/pipeline.ts (43), src/domain/ports.ts (43), src/api/routes.ts (40),
src/safety/safety-gate.ts (37), src/execution/attempt-executor.ts (16).

- Delete every comment that restates what the code does, narrates reasoning, or explains a
  rename. This includes JSDoc blocks on internal functions. Target: near-zero.
- KEEP the rare load-bearing ones, they are allowed by the repo's own rule and must survive:
  - razorpay-client.ts:235-241 — `receipt` is a lookup label, not a server-side
    uniqueness guarantee (non-obvious external behaviour)
  - recovery-worker.ts:20-23 — out-of-order audit appends hazard (if it survives item 9)
  - any comment documenting a genuine workaround or surprising constraint (max ~1 per
    non-trivial file)
- Do NOT add new comments while fixing items 5-10. Fix correctness bugs in code, not prose.
- While in each file: rename variables/functions whose names needed a comment to explain
  them; break out any function over ~50 lines or with >3 levels of nesting into smaller
  named units within the same file (do not create new files for this — no modularity churn
  that changes the import graph; tests/architecture.test.ts must still pass).
- Do not touch formatting-only changes (no whitespace-only diffs).

Accept: `grep -rEn '^\s*(//|/\*|\*)' src --include='*.ts' | wc -l` drops to under ~60 total;
typecheck + full suite green; no behavior change intended by this item (covered by tests).

### 17. Code-quality pass (from full audit; behavior-preserving)
The guardrail in item 16 about not creating new files is superseded by this item. All
changes here must keep tests/architecture.test.ts passing and the full suite green.

Do (each is small and reviewer-visible):

1. **Unify the simulated-payment marker (HIGH — protects the headline number).**
   The `_bench_` / `sim_%` / `pay_sim_` stringly-typed convention is spread across
   src/api/routes.ts:124, src/persistence/case-repository.ts:132-137, and
   src/execution/webhook-handler.ts:134. Extract one exported predicate/constant
   (e.g. `isSimulatedPaymentId`) in domain/ or persistence/ and use it everywhere.
   A rename in one place currently corrupts the live-vs-simulated money split.

2. **Shared `rupees()` in web (HIGH duplication).** Identical formatter copy-pasted at
   web/src/App.tsx:37, web/src/room/Sidebar.tsx:27, web/src/room/TopBar.tsx:8,
   web/src/loop/activities.ts:48. One export in web/src/ui (or types.ts), import everywhere.

3. **One SSE helper in api (HIGH duplication).** src/api/routes.ts:241-259 vs 261-283 are
   the same 18 lines twice (headers, snapshot-then-subscribe, 15s ping, close cleanup).
   Extract `openSse(reply, subscribe, snapshot)` into src/api/sse.ts.

4. **Extract human-directive boundary from pipeline.ts.** Move the `humanDirective` Zod
   schema, `directedProposal`, and `pendingDirective` (src/worker/pipeline.ts:35-54,
   257-265) into src/worker/human-directive.ts. Also move `directedAction()`
   (src/api/routes.ts:70-75 — business logic that does not belong in the API tier) into
   that same file. Move the `hoursSince*` helpers next to `applyGate` in a
   src/worker/gate-context.ts if it reads cleanly, otherwise just rename/split applyGate
   into `gateContext()` + `gateEvent()` (it currently does three jobs: run gate, shape
   event payload, compute reschedule delay — pipeline.ts:267-311).

5. **Move the payable-attempt selection out of routes.ts** (routes.ts:117-137, including
   the `_bench_` magic string) to a method on AttemptRepository or the executor, so routes
   only shape HTTP.

6. **WebhookHandler options object.** The constructor takes 8 positional params
   (webhook-handler.ts:79-87); main.ts:91 is unreadable. Single options object.

7. **Drop dead port methods — AFTER item 5, and only what is still dead.**
   Item 5's re-perform path may need a gateway lookup on the port; do item 5 first, then
   remove only methods with no production caller remaining. Currently dead (verify after
   item 5): `PaymentGateway.getPayment` (domain/gateway.ts:78, impl razorpay-client.ts:225)
   and `AttemptRepository.byCaseAndNo` (ports.ts:52, attempt-repository.ts:89). For
   byCaseAndNo: tests should use `listByCase` and assert on pipeline/executor behavior
   instead of reaching into persistence rows
   (tests/pipeline.integration.test.ts:270,296,334,365,382 and
   tests/attempt-executor.integration.test.ts:199,219).

8. **Zod on all route params.** The nine `req.params as { id: string }` casts
   (routes.ts:107,118,140,147,158,170,200,262,289) are unvalidated while /events
   validates its param. One shared uuid-params schema.

9. **Deduplicate `ToolSource`** (src/agent/recovery-agent.ts:9 and src/api/event-bus.ts:6):
   event-bus should import the agent's type. Also split the provider discriminator:
   export `splitModelId()` from src/agent/model.ts and use it in model-health.ts:9.

10. **Fail loudly on missing rawBody** (routes.ts:319): the
    `req.rawBody ?? JSON.stringify(req.body)` fallback silently HMACs a re-serialized body
    that can never verify. Return 500 if rawBody is absent.

11. **Small dead-weight sweep:** parse rawBody once in webhook-handler.ts:94,99; remove the
    `void tick` rerender hack (web/src/App.tsx:214) with an explicit elapsed-time state;
    fix the always-true `s.replanCount >= 0` (web/src/loop/useCaseLoopState.ts:204);
    remove the forwarding re-export at web/src/loop/activities.ts:369 (import from
    toolLine directly); un-export `istMinutesOfDay` (safety-gate.ts:84) if unused;
    inline the `terminalLane()` bare cast (pipeline.ts:378-380); remove the
    `agentRunnerFor` forwarding factory (pipeline.ts:25-27) in favor of `PipelineDeps.runAgent`;
    one shared RESOLVED_LANES const in web/src/types.ts (App.tsx:35,
    useCaseLoopState.ts:61, room/TopBar.tsx:12); reconnect-loop helper for
    useLiveRun.ts:125-160 / useRoomStream.ts:44-68 (same backoff constants and structure).

Leave alone (do not churn these before the deadline):
- src/execution/razorpay-client.ts — single responsibility, cohesive. No split.
- pipeline.ts's turn loop after the directive extraction — one class, one job; further
  splitting fragments the one place the bounded-loop semantics are readable.
- The >400-line integration test files (full-lifecycle, pipeline.integration) — cohesive
  failure-path scenarios.
- web/src types duplicated from src (PayInfo, DoneReason) — separate bundles, fine.

## Rules for the fixing agent

**Comments — read this before writing any code.** This repo's rule is near-zero comments.
Default to deleting the comment, not writing one. You may not add a comment unless the code
genuinely cannot convey the constraint, and then one short line, maximum. Forbidden:
JSDoc blocks, comments restating what a line does, comments explaining a rename, narration of
reasoning, TODOs, references to tools/agents/reviews. Three comments in the codebase are
known load-bearing and must survive: razorpay-client.ts:235-241 (receipt is a lookup label,
not a server-side uniqueness guarantee), recovery-worker.ts:20-23 (out-of-order audit append
hazard), and any single line documenting a genuine external quirk. If you find yourself
writing a comment to explain confusing code, rename or restructure the code instead.

**Other rules:**
- One logical change per commit, concise messages, no AI attribution, no Co-Authored-By.
- Do not re-record the bench cache unless an item requires it; do not touch corpus; do not
  edit the agent prompt or tools (editing them silently invalidates the recorded bench).
- Do not invent headline numbers. Deriving counts/tables from the recorded run already in
  the repo (item 4) is allowed and expected; a fresh model run to produce new numbers is not.
- No new dependencies.
- Full test suite (209 tests) and `npm run typecheck` must be green at the end, and
  `git ls-files | grep -E '(^|/)\.env$|PROJECT_REVIEW|context/'` must return nothing.
- Do not push unless the user explicitly says so.
- Priority if time runs out: all of P0, then items 5, 6, 7, 10, then 17.1 and 17.10, then
  the rest. Acceptable skips if needed: 8, 9, 15, 16, and 17 minus 17.1/17.10; say plainly
  which were skipped.
