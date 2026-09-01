# Breaks

Every time something surprises you while building, write it here — what broke, what you
expected, what actually happened, how you got out of it. This becomes the answer to the
application's "what broke, and how you got out" question, and it's only honest if it's written
in the moment, not reconstructed at the end.

---

## 2026-09-01 — A live semantic-corpus eval scored recall 0.143, and the real bug was a merchant footprint comparing a transaction to itself

- **What we expected:** after rewriting the tier-1 trigger with three new content-blind router
  reasons (`intent_unverified`, `counterparty_novel`, `content_looks_directive`) and restructuring
  the investigator's prompt to keep untrusted text delimited, a live eval against real Gemini
  (`gemini-3.5-flash-lite`) over the new semantic-investigation corpus would show the investigator
  catching at least most of four new attack classes the deterministic rules are structurally blind
  to by construction.
- **What actually happened:** the deterministic corpus came back excellent — Arm B precision
  1.000, recall 1.000, zero false positives, all 4 `benign_drift` cases correctly cleared (this
  class was the one an earlier session's recall collapse hit hardest). But the semantic corpus
  scored **recall 0.143** overall: `intent_mismatch` 2/2 caught, but `lone_counterparty_swap` 0/6,
  `price_inflation` 0/1, and `injected_instruction` 0/5 — the investigator cleared nearly every
  case it was supposed to catch.
- **How we found the actual cause:** rather than re-tuning the prompt against the aggregate number
  (a red flag we'd been explicitly warned against — no benchmark-chasing), we seeded one failed
  `lone_counterparty_swap` case standalone (the eval's own `TRUNCATE`-between-cases behavior
  destroys every case's evidence but the last one processed, so this needed a fresh standalone
  script, not a query against the eval's own leftover state) and read the actual investigation
  trail. The model's reasoning was internally consistent and well-cited: *"the transaction...
  equals the merchant median... this is ordinary drift."* It wasn't wrong given what it was told —
  `get_merchant_footprint` had genuinely reported `ratioToMerchantMedian: 1`.
- **Why:** `getFootprint`'s SQL had no way to exclude the transaction currently under
  investigation. `/verify` records the candidate's own ALLOW in `mandate_decisions` *before* the
  trigger even runs — so for a genuinely first-ever merchant, the only row the median query could
  see was the candidate's own transaction. It was, trivially and always, its own median. A ratio
  of exactly 1.0 for every brand-new merchant reads as "matches the going rate" when there is no
  independent going rate to check at all — the tool was manufacturing false reassurance, and the
  model correctly trusted evidence that was itself wrong.
- **How we fixed it:** added an `excludeCorrelationId` parameter to `getFootprint`, the same
  pattern `getHistory` already used for exactly this reason, threaded through the
  `get_merchant_footprint` tool via `ctx.correlationId`. Two regression tests pin the exact bug:
  one proves the median is `null` (not self-referential) when the candidate is the only
  transaction at a merchant; one proves the median is computed from *other* agents once the
  candidate is correctly excluded.
- **Still open:** the eval has not been re-run since this fix — see
  `context-of-buildathon/HANDOVER-P0-CONTINUATION.md` for exact next steps.
  `price_inflation`'s single failing case may share this exact root cause (its own inflated price
  was diluting the same median pool before the fix, even though other agents' lower prices were
  also seeded); `injected_instruction`'s five failures were not yet diagnosed at all when this
  session ended — that needs its own standalone trace read, not an assumption that it's the same
  bug.
- **Lesson:** a model can reason perfectly and still be wrong, because the evidence it was handed
  was wrong. "The investigator isn't catching this" and "the investigator was lied to by its own
  tools" produce the identical aggregate number and require completely different fixes — read the
  actual trail before assuming which one you have.

---

## 2026-09-01 — An independent red-team audit found `/execute` could race the investigator's own claim

- **What we expected:** an investigation "opened" — could be checked for and blocked against —
  the moment the trigger tripped inside `POST /verify`.
- **What actually happened:** it didn't. `orchestratePostAllow` enqueued the investigation job and
  returned; `INVESTIGATION_STARTED` was only written later, inside `investigate()`, after a BullMQ
  worker actually picked the job up. In the gap between those two moments, `Executor.gatePermitsStart()`
  saw `clearanceFor() === "not_investigated"` — indistinguishable from "nothing tripped" — and would
  let a job start. An anonymous `POST /execute/:correlationId` landing in that window could create
  an execution job for a transaction that was about to be held, before the hold existed anywhere to
  check against.
- **Why:** claiming and enqueueing were two different actors at two different times — the orchestrator
  enqueued, the worker claimed — and only the second one wrote the row `gatePermitsStart` depends on.
  Nothing was wrong with the claim mechanism itself (the unique partial index on `investigation_events`
  is a real mutex); the bug was *when* it ran.
- **How we found it:** an independent hostile audit (`context-of-buildathon/AUDIT-RED-TEAM.md`, F3)
  traced `gatePermitsStart()` line by line against the async enqueue path and named the exact window.
- **How we fixed it:** moved the `store.claim(...)` call out of `investigate()` and into
  `orchestratePostAllow` itself, synchronously, before the job is enqueued and before `/verify`
  returns. `INVESTIGATION_STARTED` now exists before any HTTP response naming that correlation id
  can reach a caller. `investigate()` no longer claims first; it accepts that its own investigationId
  is already claimed (that's the orchestrator, not a race) and only degrades when a *different*
  investigationId holds the claim, which is the real duplicate case. Verified with a test that reads
  back the claim between `/verify` returning and the queue ever being drained
  (`investigation-orchestration.integration.test.ts`), and with a live `/execute` call racing the same
  window (`reviewer-auth.integration.test.ts`) — both now see the hold, neither can jump it.
- **Also found, same audit:** `/mandates`, `/agents/register`, `/execute`, and `/release` had no
  authentication at all — anyone reaching the port could mint a mandate claiming to be signed human
  intent. Fixed with a server-validated reviewer session (`POST /reviewer/login`, Postgres-backed,
  httpOnly cookie — not a client-side flag) gating `/release` and `/execute` on anything currently
  held, and a per-IP rate limit on `/mandates`/`/agents/register` instead of a login, since both are
  called anonymously by the storefront itself with no accounts anywhere in the product — see
  README's Honest Limitations for exactly what that session does and does not prove.
- **Lesson:** "the mutex exists" and "the mutex is in place before anyone can observe its absence"
  are different claims. The first one had a passing test. The second one didn't, because nothing had
  ever tried to look between the two async steps.

---

## 2026-09-01 — A prompt tuned to stop one model from over-investigating made a smaller model under-investigate instead

- **What we expected:** switching the eval to `gemini-3.5-flash-lite` (the GA model, no quota
  issue — see the entry below) would give a clean rerun of the same investigator prompt that
  previously ran correctly on Groq/gpt-oss-120b and on gemini-3.6-flash in manual testing.
- **What actually happened:** a real, valid run this time (no quota error, arms genuinely
  differ) — but Arm B came back with **precision 1.000, recall 0.214, F1 0.353, mean
  investigation depth 1.1 tool calls**. The investigator cleared almost everything on the first
  or second look: it missed 100% of `amount_escalation_in_cap` (0/5), `velocity_burst` (0/1), and
  `dormant_then_drain` (0/3) — the same three classes Groq missed in an earlier run, but for the
  opposite underlying reason. Zero false positives (₹0 cost), so it's not sloppy — it's just
  stopping far too early.
- **Why:** `GOAL_TEMPLATE` in `investigator.ts` says *"You have a small step budget. Two to four
  tool calls is usually enough. Do not gather more than you need to defend a verdict."* This
  phrasing was added specifically to fix the *opposite* failure — `gpt-oss-120b` gathering
  evidence forever and never calling `submit_case` (an earlier entry in this file). It worked as
  intended on that model and on `gemini-3.6-flash`. On a smaller, faster, more literally
  instruction-following model like `flash-lite`, the same phrasing reads as a target to hit, not
  a ceiling — it takes "usually enough" as license to stop at one tool call rather than a floor
  to at least reach. The narrative rubric flagged the same symptom from another angle: `cites
  steps` passed only 2/18 times — the model is reaching verdicts without grounding them in what
  it actually looked at, consistent with concluding too fast to have real evidence yet.
- **How we caught it:** the eval completed cleanly (no error, no degrade — a real result, unlike
  the quota-killed run before it), but the identical-looking-clean output still needed a second
  look. `mean investigation depth 1.1` was the number that gave it away, same discipline as the
  entry above: don't trust a metrics table at face value, read the number that would explain *why*
  before reporting the headline numbers.
- **What this means, honestly:** this is not a wasted-cost problem. 1.1 tool calls/case is cheap,
  not sloppy — the earlier worry about burning through free-tier quota was unfounded; the actual
  issue is prompt calibration, not resource usage. It's also evidence the same prompt does not
  transfer cleanly across models of different capability tiers, which is itself worth stating
  plainly in the submission rather than hidden: model choice measurably changes recall on this
  system, and the gate's floor-can-only-tighten design is exactly why an under-investigating model
  never lets a rules-caught attack all the way through on its own say-so — Arm A's rules floor
  still applies underneath every Arm B verdict in the live system, even though the isolated eval
  numbers score Arm B alone.
- **Still open:** the goal prompt needs the "don't over-gather" language rebalanced into a floor
  ("investigate until you have real evidence for your verdict, not just a plausible first read")
  rather than a ceiling, and re-tested per model tier before the number in this entry gets used as
  a submission headline. Not fixed tonight — flagged for the next session.
- **Lesson:** a prompt tuned against one model's failure mode is not portable to a different-sized
  model without re-verification — "usually enough" is read very differently by a model that argues
  with its own instructions than by one that follows them literally.

## 2026-09-01 — The Gemini key was quota-capped after all, and the overnight eval ran on a dead key without anyone noticing until it finished

- **What we expected:** a curl against `generativelanguage.googleapis.com` with the `AQ.*` key
  earlier in the session returned a clean response with a real `thoughtSignature`, which we took
  as proof the "AQ.* keys are Antigravity-scoped and capped at 20 req/day" note in `.env` (written
  the night before) was stale or wrong for this specific key. Switched the whole session to Gemini
  on that basis — canary purchases, a live investigation walkthrough, and a full 33-case,
  both-arms `npm run eval` kicked off to run overnight.
- **What actually happened:** the eval finished after ~63 minutes with **Arm A and Arm B scoring
  bit-for-bit identical** — same precision, recall, F1, holds/1000, false-positive cost, down to
  the per-class breakdown. `mean investigation depth: 0.1 tool calls` was the tell: across every
  triggered case, the investigator loop essentially never called a tool. Querying
  `investigation_events` directly turned up the real cause: `DEGRADED_ERROR`, reason `error`,
  detail `Gemini API 429 ... "Quota exceeded for metric:
  generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model:
  gemini-3.6-flash"`.
- **Why the earlier curl test lied to us:** it was the *first* call of the day against that key,
  so it succeeded and looked like clean proof the 20/day cap didn't apply. It never got exercised
  a second time before we committed the whole session (and an unattended overnight run) to it. The
  quota was real; we'd just spent it on one lucky test before drawing the wrong conclusion from a
  sample size of one.
- **Compounding factor:** several manual canary investigations and browser-agent runs earlier in
  the same session also drew from the same 20-request daily pool, on the same key, before the eval
  ever started — so the quota may have already been thin, or gone, before `npm run eval` was even
  launched. Nothing in the harness surfaces "N requests left today" proactively; the only signal is
  a 429 on the next call.
- **The eval's own degrade path made this failure look like a real result, not a crash.** By
  design (`investigator.ts`'s `degrade()`), an LLM error doesn't blow up the run — it writes
  `DEGRADED_ERROR` and falls back to `HOLD`, exactly the fail-closed behavior the whole system is
  built around. That's correct behavior for production, but in an unattended eval it meant a dead
  API key produced a plausible-looking, fully-formed metrics table instead of a loud failure —
  identical arms read as "the investigator didn't help," when the true finding is "the investigator
  never got to run."
- **How we caught it, before treating the number as real:** the identical-arms result was
  suspicious on its face (this exact failure mode — Arm B collapsing to Arm A — is already a prior
  entry in this file, from free Groq hitting the same shape of problem for a different reason:
  under-investigation instead of total failure). Read the printed `mean investigation depth`
  line first, then queried `investigation_events` for the actual event/reason breakdown instead of
  reporting the metrics table at face value.
- **What this run is NOT:** it is not evidence that Gemini investigates worse than Groq, and it's
  not a real Arm B number for the submission. It's a quota outage wearing the shape of a metrics
  table. Treat tonight's Arm A numbers (precision 0.778, recall 1.000, F1 0.875 on rules alone) as
  the only real output of this run; Arm B needs a rerun on a key with real headroom — either a
  paid/dev-tier Gemini key, a fresh day's free quota with nothing else drawn from it first, or
  falling back to Groq with the "kept gathering, never concluded" fix already in place (documented
  two entries below) and accepting its own known weaknesses instead.
- **Lesson:** a single successful API call is not proof a quota isn't real — it's proof the quota
  wasn't zero *at that moment*. Before committing an unattended, hour-long run to a newly-verified
  key, spend a second call (or check the provider's own usage dashboard) specifically to rule out
  "I got lucky on the first try." And when two experiment arms come back suspiciously identical,
  read the metric that would reveal *why* (here, mean investigation depth) before reporting the
  headline numbers — a plausible-looking table is not the same as a validated one.

## 2026-08-29 — Parallel test files deadlocked over shared tables

- **What we expected:** vitest running `api.integration` and `executor.integration` files in
  parallel was fine; each truncates tables in `beforeAll`.
- **What actually happened:** Postgres deadlocks and cross-file data pollution — an api test
  saw `internal_error` because the executor file truncated `mandates` mid-run.
- **Why:** both files share one database; `TRUNCATE` + concurrent row locks don't mix.
- **How we fixed it:** `vitest.config.ts` with `fileParallelism: false`. Correct fix for a
  buildathon; a per-file database would be the production-grade answer.

## 2026-08-29 — Reason-union fix broke the happy path (caught by tests)

- **What we expected:** validating verifier reasons through the `DecisionReason` union
  strengthens the ledger's type integrity.
- **What actually happened:** the ALLOW reason `all_checks_passed` wasn't in the union, so
  every allow became `internal_error`.
- **Lesson:** a boundary function that maps unknowns to a safe default silently eats the
  happy path too. The union must be derived from every value the verifier actually emits.

## 2026-08-29 — Docker missing from the machine entirely

- **What broke:** `docker` not found while starting Phase 1 infra (Postgres + Redis via
  docker-compose). `/usr/local/bin` still has symlinks to `/Applications/Docker.app`, but the
  app is gone — Docker Desktop was uninstalled without cleaning up. No local Postgres, Redis,
  or Colima either.
- **Expected:** `docker compose up -d` brings up both containers.
- **Actually happened:** command not found; symlinks point at a non-existent app bundle.
- **Way out:** installed Colima + Docker CLI + compose plugin via Homebrew. Also hit that
  `brew install docker` gives the CLI only — `docker compose` needed
  `brew install docker-compose` plus a symlink into `~/.docker/cli-plugins/`. Resolved same
  day; integration tests and live smoke test green after that.

## 2026-08-29 — State-machine validation against a stale snapshot could crash the sweep

- **What we expected:** enforcing the transition table in `store.transition()` before the SQL
  compare-and-set made invalid transitions impossible.
- **What actually happened:** the guard validated against the caller's in-memory job snapshot.
  Two workers reconciling concurrently can hold contradictory snapshots; the loser's guard
  would throw `invalid state transition` mid-sweep and crash the whole sweep, even though the
  database row itself was consistent.
- **Why it happened:** check-then-act on mutable state read earlier. The DB row is the only
  truth; a snapshot is advisory.
- **How we fixed it:** inverted the transition table into `VALID_FROM` (target → allowed
  source states, derived from the forward table so they cannot drift) and enforced it inside
  the single UPDATE via `WHERE state = ANY($validFrom)`. An invalid or lost-race transition is
  now a `false` return, never a throw; callers re-read and follow.
- **Lesson:** enforce invariants against the row, not the snapshot.

## 2026-08-30 — A migration that silently did nothing against an existing table

- **What we expected:** adding `agent_id TEXT REFERENCES agents(agent_id)` directly into the
  `mandates` and `mandate_decisions` `CREATE TABLE IF NOT EXISTS` statements in `db/init.sql`
  would give those tables the new column when the migration ran.
- **What actually happened:** it silently did nothing. `mandates` and `mandate_decisions` already
  existed from Phase 1/2 — `IF NOT EXISTS` makes the whole statement a no-op against a table that
  exists, columns and all. `psql` even printed the tell (`NOTICE: relation "mandates" already
  exists, skipping`) but it read as routine idempotency noise, identical to every other table in
  the file that hadn't changed, so it didn't register as a problem until `\d mandates` came back
  without the new column.
- **How we caught it:** ran `\d mandates` / `\d mandate_decisions` against the local Postgres
  right after applying, instead of trusting a clean `psql` exit code — the new verifier code that
  reads/writes `agent_id` would have failed loudly the moment a real request hit it, but catching
  it before that point meant zero broken requests, not just a fast fix.
- **The fix:** split the migration properly — `CREATE TABLE IF NOT EXISTS` only for genuinely new
  tables (`agents`, `investigation_events`); `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for new
  columns on tables that might already exist. Re-applied, verified with `\d` again.
- **Lesson:** `IF NOT EXISTS` on `CREATE TABLE` guards the whole statement, not the columns inside
  it — adding a field to an existing table's schema always needs its own `ALTER TABLE`, never a
  bigger `CREATE TABLE IF NOT EXISTS`. Verify a migration by describing the table afterward, not
  by reading `psql`'s exit code or scanning for error lines — a silent no-op prints no error.

## 2026-08-30 — The demo's own headline scenario wasn't representable in the schema

- **What we expected:** writing a unit test for `get_tool_trace` with a trace containing
  `FOLLOW_REDIRECT` (the exact tool call `AEGIS-SPEC.md`'s demo narrative describes the
  manipulated buyer agent making) would just work.
- **What actually happened:** the test came back with an empty trace instead of the two calls it
  seeded. `KNOWN_TOOLS` — the closed enum every trace entry must belong to — only had the buyer
  agent's three ordinary tools (`SEARCH_CATALOG`, `GET_PRODUCT_DETAILS`, `PROPOSE_PURCHASE`).
  `FOLLOW_REDIRECT` failed `proposalSchema`'s enum check, which failed the whole proposal parse,
  which made the tool fall back to an empty trace — a silent, not a loud, failure.
- **Why it happened:** the demo scenario was designed in prose (`AEGIS-SPEC.md` §15.3) before the
  actual tool vocabulary was coded, and the one tool call the entire headline demo depends on was
  never added to the enum that governs what a real trace can contain.
- **How we caught it:** a unit test for an unrelated concern (trace-diffing logic) happened to use
  a realistic fixture instead of a made-up placeholder string, and the assertion failed loudly
  enough to be obviously wrong rather than silently passing on empty data.
- **The fix:** added `FOLLOW_REDIRECT` to `KNOWN_TOOLS`, documented in-line as "not a tool used in
  ordinary shopping — its presence in a trace is itself an anomaly signal."
- **Lesson:** when a design doc describes a specific scenario, write at least one test using the
  literal values from that scenario, not placeholder data — a synthetic fixture can accidentally
  validate against a schema that would reject the real thing the product is supposed to catch.

## 2026-08-30 — Colima VM image store corrupted after machine sleep

- **What we expected:** starting a new session, `docker compose up -d` just works since
  containers were healthy at end of last session.
- **What actually happened:** `docker compose ps` showed Postgres `Up ... (unhealthy)`, and
  `docker compose up -d` failed with `blob sha256:... expected at ...: input/output error`
  (corrupted containerd content store inside the Colima VM, likely from a sleep/resume or
  unclean shutdown of the VM).
- **How we fixed it:** `colima restart` (not `colima start` — restart re-provisions the VM),
  then `docker compose up -d`. Both containers came back healthy within ~15 seconds; no data
  loss (Postgres volume persisted).
- **Lesson:** when Docker/Colima acts up at session start, `colima restart` first before
  debugging application code — this is infra flakiness, not a code regression. Documented in
  HANDOVER.md as the standard session-start check.

## 2026-08-31 — The transaction under investigation polluted its own baseline

- **What we expected:** wiring `/verify` → trigger → enqueue, the tier-1 trigger would fire on a
  novel-merchant + large-amount proposal in the orchestration integration test.
- **What actually happened:** trigger returned `tripped: false` every time. Debug logging showed
  `history.length` was 9, not the 8 rows the test seeded, and `merchantNovel` was false.
- **Why:** `verifyProposal` records the ALLOW row *before* the orchestrator runs, so
  `getHistory(agentId)` returned the current transaction as part of the agent's own history — its
  merchant was no longer novel and its amount dragged the mean/stddev toward itself, suppressing
  every z-score and novelty signal. A slow-drip attack would have trained the baseline on itself.
- **How we fixed it:** `getHistory` gained an `excludeCorrelationId` parameter; the orchestrator
  and the investigator's `get_agent_history` / `get_tool_trace` / `compare_to_baseline` tools all
  pass the current correlation id so the transaction under evaluation is never in its own baseline.
- **Lesson:** any "is this normal for this agent" comparison must exclude the row being judged.
  The bug was invisible with one seeded transaction and only showed up once the current txn was
  also in the table — added a test that seeds history *and* lets the real ALLOW land before the
  trigger reads.

## 2026-08-31 — Two gate checks disagreed once soft trips existed

- **What we expected:** after splitting trips into soft/hard, a soft trip the investigator cleared
  would let execution proceed.
- **What actually happened:** the investigation concluded `cleared`, the gate banner said
  `cleared`, but `Executor.execute()` still refused with `investigation_not_cleared`.
- **Why:** the executor's step-1 gate-clearance check (`gate-clearance.ts`) used a crude rule —
  "investigation started and no `RELEASED` row ⇒ blocked" — written when every trip forced an
  `escalate` floor. Once soft trips could auto-clear, that rule contradicted `reduceGateOutcome`.
- **How we fixed it:** `PostgresGateClearanceRepository` now calls `reduceGateOutcome` over the
  same event rows, so the executor and the API banner can never disagree about a correlation id.
- **Lesson:** don't reimplement a decision in two places with two rulesets. One pure function
  (`reduceGateOutcome`), every caller reads through it.

## 2026-08-31 — First live LLM call: model name was already dead

- **What we expected:** the Gemini adapter, written against `gemini-2.0-flash` (the current Flash
  model at the time the plan was written), would just work once we had a key.
- **What actually happened:** `HTTP 404 — "This model models/gemini-2.0-flash is no longer
  available. Please update your code to use models/gemini-3.6-flash."` The key itself was fine —
  a clean API error, not an auth failure.
- **Why:** the plan and adapter were written before the key arrived; the model lineup moved on in
  between. Nothing in our code was wrong, the constant was just stale.
- **How we fixed it:** `DEFAULT_MODEL` → `gemini-3.6-flash`, kept `GEMINI_MODEL` override so the
  next rename is a config change, not a code change.
- **Lesson:** never hardcode a model id as the only reference. The `AgentLoopClient` interface
  already isolated the blast radius to one file; the env override finishes the job.

## 2026-08-31 — Gemini 3 rejects tool loops that drop the thought signature

- **What we expected:** echo the model's `functionCall` parts straight back into the next turn's
  history (the standard tool-use loop), same as every other provider.
- **What actually happened:** `HTTP 400 — "Function call is missing a thought_signature in
  functionCall parts. This is required for tools to work correctly... position 2."` The loop got
  two tool calls deep, then every subsequent turn 400'd. Investigation degraded to `HOLD`.
- **Why:** Gemini 3 thinking models attach an opaque `thoughtSignature` to each part and require
  it to be sent back verbatim on multi-turn tool use, so the model can resume its own reasoning.
  Our `LlmContentBlock` type had nowhere to carry it, so it was silently dropped on replay.
- **How we fixed it:** added an optional `thoughtSignature` to the text and tool_use block types;
  the adapter reads it off each response part and writes it back as a sibling of `functionCall`
  (not inside it). Fix confirmed by a live run that then completed: 3 tools, 2 hypothesis
  revisions, `violation` verdict at 0.98, fully cited.
- **Lesson:** a provider adapter is not just a request/response mapper — it has to round-trip the
  provider's own opaque continuation state. Test the *multi-turn* path against the real API, not
  just a single call.

## 2026-08-31 — A real investigation takes minutes, not seconds

- **What we expected:** the old hardcoded `timeoutMs` of 15s (a number two prior design rounds
  guessed with nothing behind it) would be roughly right.
- **What actually happened:** the first full live investigation ran **183 seconds** — five turns
  at 8s, 20s, 32s, 56s, 67s. Individual `generateContent` calls with a non-trivial prompt and
  dynamic thinking land around 10-70s depending on context size. Forcing `thinkingBudget: 512`
  made it *worse* (71s for a one-sentence answer); `thinkingBudget: 0` is rejected outright on
  `gemini-3.6-flash`.
- **Why:** gemini-3.6-flash does real chain-of-thought every turn, and the investigator's context
  grows with each tool result, so later turns are the slow ones. This is inherent to the model,
  not our loop.
- **How we fixed it:** this is the D2 decision from `PHASE3-IMPLEMENTATION-PLAN.md` — benchmark
  before hardcoding. `DEFAULT_TIMEOUT_MS` set to 360s. It only works because investigations are
  async (BullMQ worker, never blocking `/verify`); on timeout the gate degrades to `HOLD`.
  Consequences for the rest of the build: the demo plays back a *real recorded* investigation
  trail rather than computing it live on camera (AEGIS-SPEC §17 explicitly sanctions this), and
  the eval corpus is cut from ~200 sessions to ~40-60 held-out cases so a full batch run finishes
  overnight instead of taking a day.
- **Lesson:** "benchmark the real thing before you pick the number" was in the plan for a reason.
  The number was off by more than 10x.

## 2026-08-31 — Every new agent's first purchase got held for a human

- **What we expected:** run the buyer agent end to end against a fresh Aegis, watch a normal
  purchase clear.
- **What actually happened:** the buyer bought Sony earbuds from sony.com (in-mandate, normal
  price), Phase 1 said ALLOW, the investigation ran and correctly concluded `cleared` at 0.65 —
  and the gate still returned **HOLD**. The transaction sat in the "waiting on you" queue.
- **Why:** `young_agent_novel_merchant` was a *hard* trigger reason, forcing an `escalate` floor
  the investigator's verdict couldn't lower. Every freshly registered agent is "young" and its
  first purchase from any merchant is "novel to it", so every new agent's first transaction was
  guaranteed to need manual release. That kills the demo's "20 transactions shopped normally"
  stretch and would be unusable in production.
- **How we fixed it:** the Sybil signal now needs the merchant to *also* be fleet-fresh (first
  seen anywhere <1h ago) — a young agent AND a merchant the whole fleet just met, together. And
  it's now a *soft* trip: the investigator decides. The genuinely hard Sybil signal is
  `fleet_coordinated_campaign` (3+ distinct agents on a <15-min-old merchant), which a lone new
  agent can't trigger.
- **Lesson:** a "hard" trigger reason is a promise that a human must look at every match. Any
  reason that fires on a completely ordinary event (a new user's first purchase) cannot be hard.
  Youth amplifies other signals; it isn't one on its own.

## 2026-08-31 — The investigator kept gathering and never concluded

- **What we expected:** running the eval's Arm B on free Groq (`gpt-oss-120b`), each tripped case
  would produce a verdict.
- **What actually happened:** Arm B scored *identical* to Arm A. Digging in: a benign_drift
  investigation used all 8 tool steps (7 reads + 1 hypothesis revision) and **never called
  `submit_case`** — outcome `budget_exhausted`, gate `HOLD`. Mean investigation depth across the
  run was 2.6, i.e. most tripped cases weren't really being investigated.
- **Why:** the loop had no push toward concluding. `gpt-oss-120b` keeps gathering evidence and
  doesn't decide on its own. There was also nothing reserving the final step for the verdict.
- **How we fixed it:** (1) when `stepsUsed >= stepBudget - 1`, inject a "this is your final step,
  call submit_case now" user message; (2) `submit_case` is exempt from the step budget so a
  forced conclusion always lands; (3) the goal prompt now says "two to four tool calls is usually
  enough" and gives explicit intent-fit guidance ("a merchant being new to the agent is not by
  itself a violation if the mandate's intent covers this kind of purchase").
- **Still open:** with the fix the investigator concludes reliably, but on free `gpt-oss-120b` it
  tends to `escalate` surface-anomalous benign cases (novel merchant + elevated amount) to human
  review rather than auto-clearing them. That is a reviewable HOLD instead of Arm A's hard block
  — a qualitative improvement — but not a precision gain in the raw numbers. The clean "Arm B
  recovers benign_drift precision" result needs a more capable model (or the dev-tier quota to
  run one). The eval *harness* is complete and correct; the *numbers* are quota-limited.
- **Lesson:** an agent loop needs an explicit "you must decide now" mechanism. Left alone, a
  cautious model will investigate until it runs out of budget and then produce nothing.

## 2026-09-01 — `.env` had two live bugs blocking recording, and the first real completed eval run shows a recall collapse

- **What we expected:** `docker compose up`/`npm run dev` would just work tonight, picking up
  right where the previous session left off, and a full `npm run eval` run would finally give
  Arm B numbers now that the "kept gathering, never concluded" fix (see the entry above) was in.
- **What actually happened, bug 1:** `.env`'s `AEGIS_PRIVATE_KEY` had a stray leftover
  `-----END PRIVATE KEY-----` line and a duplicate key fragment on the line below it — a remnant
  of an old multi-line PEM edit that never got cleaned up when the key was pinned to the
  single-line base64 DER form. `docker compose` refused to even parse the file
  (`unexpected character "+" in variable name`). The already-running containers were unaffected
  (they'd been started before the file was touched), but any fresh `docker compose` invocation
  tonight would have failed cold, and a corrupted signing key is exactly the kind of thing that
  silently invalidates every mandate signed against it if it goes unnoticed.
- **What actually happened, bug 2 (the more dangerous one):** `.env` also had
  `INVESTIGATION_TIMEOUT_MS=120000` (120s) — a leftover from before the timeout fix documented
  elsewhere in this file, which set the code's own `DEFAULT_TIMEOUT_MS` to 360s specifically
  because a real live investigation took 183s. The `.env` override silently undercut that fix. A
  canary run confirmed it live: a real investigation was still mid-flight, having made 3 real
  tool calls, when it hit `DEGRADED_TIMEOUT` at the 120s mark. This would have hit live, on
  camera, during the manipulation beat — the one moment the whole demo's thesis depends on the
  investigator actually concluding.
- **Why both happened:** neither value was touched by the code fixes that made them obsolete —
  the fixes landed in source (`signer.ts`'s single-line-DER support, `DEFAULT_TIMEOUT_MS=360000`)
  but the local `.env` was never revisited to match. A working default in code doesn't help if an
  environment override is still shadowing it.
- **How we caught it:** ran `docker compose ps` before touching anything (routine session-start
  check per the Colima lesson below), got the parse error immediately. The timeout bug was only
  found because a canary browser-agent purchase was run deliberately as a dry run *before*
  recording, specifically to avoid finding this live on camera — it triggered a real investigation
  (`young_agent_fresh_merchant`), which then degraded to `DEGRADED_TIMEOUT`/HOLD instead of
  concluding.
- **How we fixed it:** removed the two stray PEM lines (the active `AEGIS_PRIVATE_KEY` line
  itself was already correct, single-line base64 DER, matching what HANDOVER.md documents as
  pinned); set `INVESTIGATION_TIMEOUT_MS=360000` to match the code default. Restarted the API
  process, re-ran the canary — a full purchase completed and captured cleanly on the next attempt
  (no trigger fired that time, so it didn't re-exercise the timeout path, but the dev server log
  confirmed the corrected value loaded).
- **The eval run itself (33 held-out cases, Groq `gpt-oss-120b`, `EVAL_TIMEOUT_MS=360000` passed
  explicitly since the script's own default is still 120000):**
  - **Arm A (rules only):** precision 0.778, recall 1.000, F1 0.875, 545 holds/1000,
    ₹120,000 false-positive cost (4 lost sales).
  - **Arm B (rules + investigator):** precision 0.833, recall 0.357, F1 0.500, 182 holds/1000,
    ₹30,000 false-positive cost (1 lost sale).
  - Arm B is strictly better on precision and false-positive cost (fewer legitimate transactions
    wrongly held), but **recall collapses** — it fully misses `amount_escalation_in_cap` (0/5),
    `velocity_burst` (0/1), and `dormant_then_drain` (0/3), three whole classes the rules alone
    caught every time. `counterparty_swap` and `category_jump` still hit 100% recall in both arms.
  - This matches the still-open caveat in the entry above almost exactly: on free `gpt-oss-120b`
    the investigator is conservative to a fault on cases with an in-range amount and no obviously
    weird trace, and clears things it should have escalated. The earlier entry guessed this would
    show up as an under-flagging pattern before a model-graded number existed to confirm it; this
    run is that confirmation, with the actual numbers instead of the guess.
- **Still open:** exactly as the entry above says — the eval *harness* is complete and correct,
  this is a genuine, honestly-measured result, not a bug in the eval itself. The plan is to rerun
  the same 33-case split against Gemini (already proven to complete real multi-turn investigations
  correctly per the 2026-08-31 entry on thought-signature handling) and report both models' numbers
  side by side, labeled by model — not to quietly swap the number the video uses. The architecture
  point stands regardless of which model runs: the gate can only tighten the trigger's rules floor,
  never loosen it, so a model that under-flags loses recall but never lets an actually-blocked
  class of attack all the way through to execution on its own say-so.
- **Lesson:** a numeric env override left in `.env` after the code's own default changes to fix it
  is a silent regression — it doesn't show up as an error, it shows up as the old broken behavior
  coming back exactly as if the fix had never shipped. Worth a standing habit: when a `DEFAULT_*`
  constant changes in source specifically because a documented incident proved the old number
  wrong, grep the local `.env` for the same variable name before trusting the new default is
  actually in effect.

## 2026-08-31 — `release` could clear a DENY, not just a HOLD

- **What we expected:** `POST /investigations/:id/release` exists for one thing — a human
  clearing an `escalate` HOLD they've reviewed. A `violation` verdict (gate DENY) shouldn't be
  releasable at all; that's the whole point of the DENY/HOLD distinction.
- **What actually happened:** found while building the investigation room's release button.
  `reduceGateOutcome` treated *any* `RELEASED` row as an unconditional `return "cleared"`,
  checked before the verdict was even read. Call `/release` on a `violation` correlation id and
  the gate flips straight to `cleared` — `PostgresGateClearanceRepository.clearanceFor` reads
  that same reducer, so the executor would have paid it out.
- **Why:** the early-return was written for the one case in mind (an `escalate` HOLD) and never
  re-examined once `violation` → DENY existed as a distinct outcome from `escalate` → HOLD.
- **Impact in practice:** the shipped investigation-room UI only ever renders the release button
  when `gate === "HOLD"` (never `DENY`), so nothing built this session could trigger it through
  the UI. But the API endpoint itself had no server-side guard — anything hitting it directly
  (curl, a script, a different client) could have overridden a violation. Caught before ship,
  not after.
- **How we fixed it:** `reduceGateOutcome` now computes the outcome first, *then* only lets a
  `RELEASED` row downgrade a `HOLD` to `cleared`. A `DENY` stays a `DENY` no matter how many
  `RELEASED` rows exist. Added `tests/gate.test.ts` cases (release clears a degraded HOLD too;
  release can never clear a violation) and an integration test in
  `tests/investigation-orchestration.integration.test.ts` that calls `/release` on a
  violation-verdict investigation end to end and asserts the executor still never runs.
- **Lesson:** "the UI never exposes this" is not a security boundary — the invariant has to hold
  at the layer that actually gates money movement (`gate.ts`, read by both the API's display
  reducer and the executor's own clearance check), not just at the one client that happens to be
  well-behaved.

## 2026-08-31 — Ran the integration suite against the live demo database mid-session

- **What we expected:** running `npx vitest run` for a pre-commit check would just check the code.
- **What actually happened:** the integration tests' `beforeEach` does `TRUNCATE mandate_decisions,
  ... investigation_events` against `DATABASE_URL` — the same Postgres the interactively-running
  dev server was pointed at while I had a live investigation open in the browser. The room's
  gate banner briefly rendered `cleared` for an investigation whose rows had just been wiped —
  `reduceGateOutcome([])` correctly returns `"cleared"` for zero events (no `INVESTIGATION_STARTED`
  to find), which is the right answer for "nothing on record," but confusing to watch live without
  knowing the table underneath had just been emptied.
- **Why:** no separate test database configured; `DATABASE_URL` in `.env` is the same one both
  `npm run dev` and `vitest` read by default.
- **Impact:** display-only. The executor's own clearance check (`gate-clearance.ts`) is a
  live read at execution time, not the cached banner state — it was never at risk, and the
  release-can't-clear-a-violation test added this session (which exercises that exact path)
  still passed cleanly afterward.
- **Fix applied:** none — noted as a discipline lesson, not a code bug. A real fix would be a
  separate `TEST_DATABASE_URL`, out of scope for this session.
- **Lesson:** never run the integration suite while a demo/session has live state in the shared
  dev database worth keeping. Seed demo data *after* the last test run, not interleaved with it.

## 2026-08-31 — The documented test card (4111 1111 1111 1111) fails on this account

- **What we expected:** per the brief and every generic payment-gateway testing guide, card
  `4111 1111 1111 1111` (any future expiry, any CVV) succeeds in test mode.
- **What actually happened:** explored the real Razorpay Checkout iframe with Playwright before
  writing any browser-agent logic, exactly as asked. Both `4111 1111 1111 1111` (Visa) and the
  commonly-cited domestic Mastercard number `5104 0155 5555 5558` failed identically:
  `"Payment could not be completed — International cards are not supported."` Checked against
  Razorpay's own Payments API (`GET /orders/:id/payments`) to get ground truth, not just the UI
  message: both attempts show `"international": true`, `"error_reason":
  "international_transaction_not_allowed"`, `"error_description": "...this business accepts
  domestic (Indian) card payments only."` Razorpay's own BIN lookup classifies both numbers as
  non-Indian-issued — they're the generic test numbers used across many payment gateways
  (Stripe's included), not Razorpay-specific Indian test BINs, and this test account only
  accepts domestic cards.
- **Why:** couldn't find Razorpay's actual documented India-specific test card number — their
  docs page renders the table client-side and neither `WebFetch` nor a PDF export of the same
  page returned it as text.
- **What we verified instead:** Netbanking, end to end, for real. Selecting a bank
  (`Bank of Baroda - Retail Banking`) opens Razorpay's own mock bank page
  (`api.razorpay.com/v1/gateway/mocksharp/payment`) in a **new tab** — a plain page with
  Success/Failure buttons. Clicking Success closes that tab, returns to the original page, and
  fires the Checkout `handler` callback with a real `payment_id`. Confirmed captured via the
  Payments API: `"status": "captured"`, `"method": "netbanking"`.
- **What this means for the browser agent (commit 7):** Playwright's accessibility snapshot
  pierces the cross-origin Checkout iframe cleanly — every field, radio, and button got a stable
  `ref` the same way a same-origin page would, including the pop-up mock-bank tab. The mechanics
  are fully reliable. The one thing genuinely fragile is the *card* path specifically, because
  the well-known test number doesn't work on this account. **Decision: the browser agent drives
  Netbanking, not card entry**, since it's the path actually verified live. If card entry on
  camera matters for the demo, the fix is pulling the account's real domestic test card number
  from the Razorpay dashboard directly (Test & Live Mode → test card details are sometimes
  account-specific), not guessing at another generic number.
- **Lesson:** never assume a documented test credential works against a specific account without
  checking — "the docs said so" isn't verification. The API's own error payload was more useful
  than the UI message alone: the UI just said "international," the API said exactly why
  (`international_transaction_not_allowed`) and confirmed via `card.international: true`.

## 2026-08-31 — Building the browser agent found two real bugs the exploration missed

- **What we expected:** the netbanking mechanics already worked once, live, via manual Playwright
  MCP tool calls — porting the same steps into `demo/browser-agent/browser-tools.ts` should just
  work.
- **What actually happened, bug 1:** `page.getByTestId("catalog-json").or(page.getByText(...)).first().waitFor()`
  timed out even though the element existed — Playwright's error log said
  `locator resolved to hidden <script type="application/json" ...>`. `.waitFor()` defaults to
  `state: "visible"`, and a `<script>` tag has no render box, so it can **never** satisfy a
  visibility wait, no matter how long you wait. Same bug hit `openProduct` and `goToCart`'s
  `waitForSelector` calls — three call sites, one root cause. Fixed by passing
  `state: "attached"` explicitly everywhere a hidden JSON-blob element is being waited for.
- **What actually happened, bug 2:** after fixing bug 1, `submit_checkout` correctly returned
  `paying` (a real cleared transaction, real order created — confirmed via
  `GET /executions/:correlationId`), but `complete_payment` still timed out waiting for
  `iframe[src*="checkout.razorpay.com"]`. First hypothesis: Razorpay's PerimeterX/hCaptcha bot
  detection was flagging the Playwright-launched Chromium as non-human (its scripts were visibly
  loading in the console). Tested headed vs. headless to check — but the actual cause was
  simpler: `page.locator("iframe").first().getAttribute("src")` showed the real iframe loads
  from `https://api.razorpay.com/v1/checkout/public?...`, not `checkout.razorpay.com` — that
  domain only hosts the *loader script*, not the Checkout iframe itself. One-line selector fix
  (`iframe[src*="api.razorpay.com/v1/checkout"]`), no bot-detection issue at all.
- **How we found it, honestly:** the first scripted smoke test "passed" (exit cleanly, printed a
  success summary) while `executor_jobs` was empty in the database — the scripted test client
  blindly replays a fixed step sequence regardless of what each tool actually returned, so a
  clean exit proved nothing. Caught by checking ground truth (the DB, then the Payments API)
  instead of trusting the process exit code. Added output/error to every `toolLog` entry in
  `agent.ts` so a real run's log actually shows what happened at each step, not just what was
  attempted — this was a real gap in the production code, not just the throwaway test script.
- **Verified for real after both fixes:** full pipeline, real browser (headed Chromium), real
  storefront, real WebCrypto-signed proposal, real Aegis trigger evaluation, real Razorpay
  Checkout iframe, real mock-bank tab, real Success click. `GET /executions/:correlationId`
  confirmed `"state":"CAPTURED"` with a real `orderId` and `paymentId`.
- **What's still only checked once, not repeatedly:** the fully-captured run above was headed
  (`headless: false`); headless mode was confirmed to reach the same fixed iframe correctly but a
  second run to a full capture in headless specifically got blocked by `fleet_coordinated_campaign`
  (a real, correct trigger — the small 7-item demo catalog ran out of untouched merchants after
  this much manual testing) before it could complete. The fix is identical in both modes and
  nothing in it is headless-specific, but only headed has an unbroken capture behind it.
- **Lesson:** a scripted "smoke test" that ignores tool outputs isn't a test, it's a script that
  doesn't crash. Verify against ground truth (the database, the payment provider's own API), not
  against your own harness's silence.
