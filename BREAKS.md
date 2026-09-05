# What broke, and how we got out

This is the live engineering failure log for RecoveryOps.

It is intentionally not a polished postmortem. Entries were added as failures were discovered during implementation, testing, benchmarking, and final audit.

The purpose is to preserve:
- What we expected
- What actually happened
- Why it mattered
- How it was diagnosed
- What changed
- What regression test or safeguard prevents recurrence

---

## The short version

The most consequential failures, grouped by impact:

**Safety & financial control:**
1. **Risk-hold veto wasn't wired** — Optional callback was never passed; misdiagnosed risk-flagged payments could bypass human review
2. **WRITE_OFF could close risk holds permanently** — CAUTION_RANK measured money movement, not human visibility
3. **Risk-hold veto couples to `failureReason`** — Blinding the label (benchmark experiment) disables the deterministic veto

**Benchmark integrity:**
4. **Benchmark leaked answers through prior-attempt data** — Agent read recovery hints from `outcome_detail`
5. **Benchmark graded actions at creation, not settlement** — Punished timing and rail-switching
6. **Fixed baseline was structurally unfair** — Only proposed retries, lost all link/nudge cases
7. **Downtime matching was incorrect** — Matched on method (card) instead of specific issuer (Bank of India)
8. **Degraded diagnoses fabricated as `technical`** — Null → "technical" inflated root-cause accuracy

**Reliability:**
9. **Duplicate webhook could drop a real capture** — Dedupe assumed first delivery finished
10. **Human escalation was a dead end** — Directives were written but never read

**Infrastructure:**
11. **Benchmark cache replayed stale recordings** — Zero model calls looked like a valid result
12. **Schema bind-mount served truncated file** — GRANT statements past line 97 were skipped
13. **Spend cap charged a flat constant, 2.1x low** — No code path had ever read a token count

Each failure below documents what broke, how it was found, and what prevents recurrence.

---

## Detailed failure log

Entries are organized chronologically as they were discovered. Each documents what broke, why it mattered, how it was diagnosed, what changed, and what safeguard prevents recurrence.

---

## Day 0: Stack assumptions

Probed every external assumption against the live APIs instead of trusting the plan.
- The planned model (`gemini-2.5-flash`) was retired : `404`, points at `gemini-3.6-flash`.
- The Gemini key was quota-capped: a deliberate 25-call burst got 16 successes then 9 straight
  429s. The eval needs ~700 calls/run. Unusable.
- Every route to a paid Gemini key was closed : billing signup failed (`OR_BACR2_44`), and
  Google's own docs say the $300 trial credit cannot be spent on the Gemini API at all.
- The planned headline failure code, `do_not_honor`, is an ISO-8583 code, not a Razorpay
  `error_reason` value. A Razorpay reviewer would have caught a fabricated code immediately.

**Fix:** moved to OpenRouter (no minimum, no cloud billing account). Corrected the corpus to
Razorpay's real `error_reason` vocabulary. **Unexpected upside from the same sweep:**
`GET /v1/payments/downtimes` answers on the test key with real data : that became the spine of
the downtime-diagnosis feature instead of a footnote.
**Safeguard:** the model id is always an env override, never a constant; a quota probe is a
30-second burst test before any unattended run depends on a new key.

---

## `receipt` looks like an idempotency key. It isn't one, and the reconciliation read lags.

**Expected:** on an ambiguous order-create (5xx/timeout), `GET /orders?receipt=<key>` tells us
whether it landed.
**Actual:** an order confirmed to exist via `GET /orders/:id` came back `count: 0` from the
filtered list query. Razorpay's order *list* index is eventually consistent (lag on the order of
minutes, unbounded) even though direct-by-id reads are immediate. Separately, `receipt` is not
enforced unique at all : two orders with the same receipt both succeed. Payment links are the
opposite: `reference_id` duplicates are rejected server-side.
**Why it's dangerous:** the reconciliation read runs exactly in the window the list index hasn't
caught up : "not found" would have been read as "safe to retry," producing two real orders for
one attempt, precisely when the gateway is already unhealthy.
**Fix:** the attempt row's own `UNIQUE idempotency_key` is the authority, not Razorpay's list.
Ambiguous creates land in `AWAITING_RECONCILIATION` and are never concluded from list absence.
Payment link duplicate-reference errors are now treated as success-plus-lookup.
**Safeguard:** a read used to decide "did my write land" is tested with zero delay between write
and read : a test that sleeps is testing a different system than production runs.

---

## The risk-hold veto was wired to nothing

**Expected:** the safety gate independently vetoes any risk-flagged payment.
**Actual:** the veto read `proposal.diagnosisRootCause === "risk_hold"` plus an optional
`riskHoldForCase` callback that was never actually passed at any construction site. A payment the
agent misdiagnosed as `soft_decline` would sail straight through to an auto-retry.
**Fix:** `isRiskHold(kase)` reads Razorpay's own `payment_risk_check_failed` reason directly off
the case : independent of what the agent concludes, wired at every pipeline construction site.
**Safeguard:** the pipeline suite runs the gate against a misdiagnosed risk case and asserts zero
gateway calls.

---

## `WRITE_OFF` could bury a risk hold with no human ever seeing it

**Expected:** `CAUTION_RANK` : the gate's directional ordering : meant "never less cautious"
covered every guardrail, including risk holds.
**Actual:** the first exhaustive property-test run failed immediately. `WRITE_OFF` and `ESCALATE`
rank equal on `CAUTION_RANK` (neither moves money), so a risk-hold case the agent proposed to
`WRITE_OFF` passed the rank check and was allowed : closed permanently, no reviewer ever notified.
**Why:** the ladder measures how much money moves. `ESCALATE` and `WRITE_OFF` are identical on
that axis and opposite on the axis that actually mattered here : whether a human sees the case.
**Fix:** the risk-hold veto no longer consults the rank at all: `if (riskHold && kind !== "ESCALATE")`.
**Safeguard:** two tests pin it, one exhaustive, one naming the exact bug. `CAUTION_RANK` is now
documented as a money-movement ordering only : anything asking "must a human see this" must be
an explicit check, never inferred from rank.

---

## The bench was handing the agent its own answer key

**Expected:** the agent beats a fixed retry schedule because it diagnoses better.
**Actual:** it beat it because `ground-truth-resolver.ts` wrote the corpus's answer straight into
the failed attempt's `outcome_detail` : strings like "too early (recovers at +72h)". That column
is exactly what `get_this_case_prior_attempts` feeds back to the agent on its next turn; the
recorded reasoning quotes it back verbatim.
**Fix:** every failed verdict now returns a flat `"payment declined"`, regardless of why.
**What it cost:** the honest number after the fix was 45.0% agent vs 46.7% fixed : the agent
*losing*. The old headline is retired and must never be quoted again.
**Safeguard:** a test drives the resolver through every failure branch and asserts the detail
matches no recovery-hour or corrective-hint pattern.

---

## The bench graded a decision at the moment it was made, not the moment it would settle

**Expected:** a `RETRY_SCHEDULED +72h` is graded 72 hours out.
**Actual:** `GroundTruthResolver.resolve()` was called synchronously the instant the action was
created, so a `+72h` retry was judged at hour 0 and failed before the sim clock had moved. An
outreach was graded the instant it was sent, before the customer could plausibly have acted.
**What that did:** it punished exactly the behaviors the agent exists for : timing a retry,
switching rails. Every `card_expired` case correctly proposed a nudge, was graded a failure
before the customer could respond, and the agent : correctly told not to repeat a failed move :
re-planned onto the wrong action and escalated. The fixed schedule, which never reads feedback,
was immune.
**Fix:** the resolver now grades an action at the hour it actually settles.
**What it cost:** 45.0% → 65.0% agent recovery rate on the same recorded turns, zero new model
calls needed to re-measure. The fixed arm's own count was unchanged, only faster.
**Safeguard:** four tests pin the settlement-timing semantics directly. General rule adopted:
replay every recorded turn through a from-scratch re-simulation and read the actual attempt
chains in Postgres before trusting any bench headline : neither this bug nor the one above would
have been caught from the summary metrics alone.

---

## A tuning experiment hit 100% of its own ceiling : and wasn't shipped

**Expected:** three targeted changes (a new customer-history signal, a corpus template anchored
to a real payday, two prompt lines) would close some of the remaining gap.
**Actual:** one paid re-record came back at 73.3% agent vs 46.7% fixed, recovering **every
single** corpus case marked recoverable by construction. Zero misses. A pre-declared stop
condition (a gap above ~20pp, set *before* the run, based on published smart-retry benchmarks)
tripped immediately.
**Why it's a red flag, not a win:** recovering literally every recoverable case on a synthetic
eval is the textbook shape of a system tuned against its own test, not evidence of better
judgment on a fair one.
**How we got out:** reverted all three changes in full, confirmed zero remaining diff against the
pre-experiment commit. Spent one further authorized paid re-record on a clean rerun with none of
the three changes present : landed at 68.3% vs 46.7%, inside noise of the pre-experiment result,
and shipped that instead. The overfit run's cache is archived, not deleted, so the shape of an
overfit result on this corpus isn't lost.
**Safeguard:** a ~20pp gap or 100%-of-ceiling recovery on this bench is now a standing signal to
distrust the run, not celebrate it : set and written down before running the experiment, not
rationalized after seeing the number.

---

## The fixed schedule was a strawman; a 6-line switch beats the agent

**Expected:** the shipped 21.6pp gap (68.3% vs 46.7%) was the honest measure of judgment.
**Actual:** it wasn't. The fixed-schedule arm only ever proposes a retry : it structurally loses
every case needing a different rail (a payment link, a nudge), regardless of any timing logic.
The gap was "three rails beat one," not "diagnosis beats a calendar." A third arm transcribing the
agent's own system-prompt playbook into a 7-line `switch` on `error_reason` : no model, ₹0 :
recovered 43/60 (71.7%, ₹64,457), beating the agent's 41/60.
**Why:** the corpus was 7 templates and the playbook was 7 lines, one per template. A table built
from the same lines the agent already had wins, because there's nothing left for judgment to add
on a fully-enumerated taxonomy.
**How we got out (this session's own audit, on top of the earlier one):** rather than accept the
loss, went hunting for *why* judgment wasn't adding anything, and found two compounding bugs: the
downtime tool matched on payment method instead of the specific issuing bank, so it returned
`matched: true` for every card case regardless of which bank : writing fabricated "the bank is
down" claims into the audit trail on 43 of 54 downtime diagnoses in the recorded run : and the
root-cause playbook was baked into the system prompt, so the model was retrieving the table
rather than reasoning to it. Fixed the tool (issuer-specific match, separate from method-wide
context, with a real regression test : the old one had silently varied two variables at once and
missed the bug). Moved the playbook behind a tool call the model must choose to invoke. Rebuilt
the corpus with real, stated ambiguity: a 20% share of generic declines actually downtime-driven,
and a genuine history-trend split (not a record count) on `insufficient_funds`. Re-ran clean:
agent 42/60 (₹60,458) vs rules 43/60 (₹59,457) : a near-tie on the action-policy race, honestly
reported as such : plus **71.7% root-cause diagnosis accuracy, a number the rules table cannot
produce at all**, since it never diagnoses anything.
**Safeguard:** the rules table ships as a permanent third arm, reported by default, never hidden.
Root-cause accuracy is graded separately from the action taken specifically so a lookup table's
structural win on one axis can't be used to claim (or hide) a loss on the other.

---

## A duplicate webhook could permanently drop a real capture

**Expected:** `razorpay_webhooks.event_id` dedupe means a redelivery is a safe no-op.
**Actual:** it assumed the first delivery *finished*. If the process died between recording the
event id and settling the attempt, the attempt stayed `PENDING` : and a redelivery of the same
event id hit the dedupe check and did nothing, discarding the only remaining signal that the
money had landed.
**Fix:** a redelivered event id is only a true no-op once the attempt it names has actually
reached a terminal state. Still `PENDING` or `AWAITING_RECONCILIATION`: the handler settles from
the redelivered event instead of trusting the dedupe alone.
**Safeguard:** a regression test seeds exactly that crash window and asserts the redelivery
settles it. General rule: event-id dedupe on a settlement webhook has to be paired with a check
that the thing it settles actually reached a terminal state, or a redelivery becomes
indistinguishable from "already handled" when it's really "never finished."

---

## Our own headline metric was inflated by our own fallback constant

**Expected:** a degraded investigation : one that never reached a diagnosis : leaves the root
cause unrecorded. `domain/recovery-action.ts` says exactly that in a comment: "null when the loop
degraded... never guessed."
**Actual:** `worker/pipeline.ts` wrote `proposal.diagnosisRootCause ?? "technical"` into the
attempt row one file away from that comment. The database column was `NOT NULL`, so a degraded
proposal silently became a fabricated diagnosis of `"technical"`. In the published batch, 7 of 60
first turns degraded with no diagnosis at all; 2 of them happened to land on cases whose real
cause the corpus marks as `technical`, so they scored as *correct* diagnoses in the eval. The
published root-cause accuracy, 71.7%, was inflated by a fallback value the agent never produced.
**Why it's dangerous:** it's exactly the failure mode the codebase's own rules forbid : "never a
fabricated RootCause" : reintroduced by one default operator, in the one place a wrong number
would flatter the headline claim rather than cost it. A hostile reviewer who read the domain
comment and then the pipeline file would find this in under a minute.
**How diagnosed:** a final self-audit before submission, re-reading `pipeline.ts` against the
invariants stated in its own neighboring files rather than trusting that the code matched them.
**Fix:** `root_cause` is nullable end to end : the schema column, the domain type, the repository
mapping, the pipeline write. `bench/metrics.ts` scores a null first-attempt cause as *not
correct*, denominator unchanged, rather than excluding it (which would have flattered the number a
different way). The honest figure on the same recorded turns dropped 71.7% → 68.3%, published as
such, before the corpus was hardened and the agent re-recorded on a better model : see below.
**Safeguard:** `tests/pipeline.integration.test.ts` asserts a degraded proposal's attempt row has
`root_cause IS NULL`, reading the raw column, not just the mapped domain type.

## The escalation rail was a dead end

**Expected:** a human resolving a "waiting on you" case (retry / redirect / write off) changes
what happens to that case next.
**Actual:** `POST /cases/:id/decision` validated `redirectTo` with Zod, wrote it into the audit
payload, and never read it again. Approve and redirect both did the identical thing :
`ESCALATED → RETRY_SCHEDULED`, re-enqueue : which re-ran the agent, which reached the same
conclusion that escalated the case the first time, which the gate vetoed again for the same
reason. A human could click three different buttons on a risk-hold case and change nothing; only
write-off actually did anything.
**Why it's dangerous:** the track's bar explicitly names "compliant escalation" as a graded
clause. A control that visibly exists but silently does nothing is worse than not having it :
it implies a human-in-the-loop safeguard that isn't there.
**Fix:** the decision route now records a `HUMAN_DIRECTIVE` event : the chosen action, an
approver identity, a timestamp : in the append-only log before moving the case. The pipeline reads
the newest undischarged directive for a case, performs exactly that action instead of invoking the
agent, and still runs it through the gate. The gate gained a `humanAuthorization` field that
satisfies exactly two of nine rules (`risk_hold`, `exposure_cap` : the two that exist specifically
to force a human decision) and never the two with regulatory weight (`hard_decline`, the attempt
cap) or either cooldown. The stated invariant : no LLM path can lower caution : is now restated
precisely rather than silently narrowed: *no agent-originated path* can lower caution; a recorded
human decision can, over exactly two rules.
**Safeguard:** `tests/safety-gate.test.ts` gained a full second dimension (`humanAuthorization`)
proving the existing 4,608-context sweep is byte-identical with it absent, plus targeted
properties for what authorization does and does not unlock. `tests/pipeline.integration.test.ts`
drives a real directive end to end: the agent is never invoked, the directed action lands, and a
hard-decline case still refuses an authorized reattempt.

## The fix for the dead escalation rail had its own bug, found live

**Expected:** a human's directive on a freshly-escalated case executes immediately.
**Actual:** while proving the fix above by hand : escalate a risk hold, then immediately direct it
to `PAYMENT_LINK` : the case went to `RETRY_SCHEDULED` instead, parked for 6 hours. The charge
cooldown (`hoursSinceLastAttempt`) was computed from *any* non-`SKIPPED` attempt, and the ESCALATE
attempt that had just fired : which never touches Razorpay : counted as "the last charge." A
human's very next decision, on any case that had ever escalated, was silently rate-limited by an
action that moved no money at all.
**Why it's dangerous:** the concept "which actions move money" was defined three separate times
(`attempt-executor.ts`, `safety-gate.ts`, and this cooldown filter), slightly differently each
time. Two of the three were correct; the third : the one actually gating a human's authority :
wasn't, and nothing would have caught it without exercising the real flow end to end.
**How diagnosed:** running the fixed escalation rail live against a real case, not just the unit
tests : the unit tests for `pendingDirective`/`applyGate` used fixtures that never modeled an
ESCALATE attempt immediately preceding a directive, so they were green while the real flow was
broken.
**Fix:** one canonical `MOVES_MONEY` constant in `domain/recovery-action.ts`, used by the
executor, the gate, and the cooldown filter : the three call sites that used to each define it.
**Safeguard:** a regression test pins exactly this scenario: escalate, direct immediately, assert
the directed action executes rather than getting parked.

## The bench cache silently replayed a stale recording, with the truth printed right there in the log

**Expected:** re-running the evaluation after changing the corpus and the prompt calls the model
again and records fresh turns.
**Actual:** `recordingRunner` keys its cache purely by `customerRef#attemptNo`, both stable across
a corpus regeneration. After hardening the corpus and de-spoonfeeding the prompt, a same-seed,
same-size re-run replayed every one of 106 cached turns from the *previous* corpus and prompt, and
printed a complete, plausible-looking scoreboard : root-cause accuracy identical to the prior run
down to the decimal. The only tell was one line above the table: `0 model calls, ~$0.000 est`.
**Why it's dangerous:** the output was fully formed and internally consistent. Without reading the
cost line, this would have shipped as "the re-recorded result" while the model was never actually
called against the changes it was supposed to be measuring.
**How diagnosed:** reading the run's own cost summary before trusting its scoreboard : the habit
this project's earlier quota-probe safeguard already established, applied to a different failure
shape.
**Fix:** the cache path now includes the model id (`bench/run.ts`), not just seed and size. This
also makes a same-corpus, cross-model comparison possible at all, rather than each run silently
overwriting the last one's recording : which is what caught a second, real instance of the same
class of bug seconds later, when a "clean" comparison run against the free-tier model also showed
`0 model calls` because it had genuinely, correctly reused a recording from moments before.
**Safeguard:** treat `N model calls, ~$X est` as part of the result, not incidental logging : a
re-record that reports zero calls is not a result, it's a cache hit wearing a result's shape.

---

## Two guardrails were provably unfalsifiable, and a fair model comparison needed the same conditions

Not a bug : a gap the final hardening pass closed deliberately, recorded here because it changed
the published numbers. The over-nudge rate read 0.0% in every arm and could not structurally read
anything else: every case where `CUSTOMER_NUDGE` was the right move had `selfRecovers: false` by
construction, so a wrong nudge was unreachable. The exposure cap never fired in the measured batch
either : the highest corpus amount sat below the cap. Added a self-recovering slice of
`card_expired` (an issuer's own account-updater fixing the card before contact : a genuine,
real-world unknowable, not an invented edge case) and a fifth amount tier above the cap. Both
guardrails now fire in the batch itself: over-nudge rate reads 3.3–8.3% across seeds, and
`exposure_cap` shows up in the per-rule firing counts alongside `risk_hold`, `contact_window`, and
`write_off_unsupported`.

Separately, the recovery playbook's own notes stated the corpus's ground truth as advice : "~48-72h
out" against a true value of exactly 72 hours, "12-24h" for downtime against a true value of 12 or
14. Stripped every timing number, left the mechanism-level guidance, and pointed at the tools that
already carry the real signal (the customer's own payment cadence, the downtime feed's own
window). Re-recorded on the harder corpus and the de-spoonfed prompt, root-cause accuracy held at
71.7–75.0% across five seeds : the diagnosis capability survived losing the crutch. The action-
policy money numbers, honestly, did not improve; they were never the row this project is staking
its AI-judgment claim on. See the root-level README's "The number" section for the full table,
including where the free-tier model, run under the identical harder conditions, collapses to
8.3% root-cause accuracy and an 86.7% degrade rate : the size of the model-quality tax this
project is not paying for its headline result.

## The schema apply script silently ran a truncated file

**Expected:** `npm run db:schema` applies the full `db/schema.sql`, GRANT statements included.
**Actual:** `docker-compose.yml` bind-mounts `db/schema.sql` as a single file into the Postgres
container. Editing the file (adding the nullable-`root_cause` migration) gave it a new inode; the
mount kept serving a stale, truncated 97-line view of a 118-line file to a command run moments
later : `psql -f /docker-entrypoint-initdb.d/init.sql` inside the container, reading through that
stale mount. The GRANT statements enforcing append-only sit past line 97. On a fresh machine,
running this exact command after any edit to `schema.sql` could apply a schema with the audit
tables silently writable by the app role : the one invariant this project treats as
non-negotiable : with no error, because everything before the truncation point ran cleanly.
**Why it's dangerous:** it fails silently. `CREATE TABLE ... IF NOT EXISTS` and friends don't
error on a short file; the command exits 0. The append-only test would eventually have caught it
in CI, but a manual `npm run db:schema` during setup gives no signal at all.
**How diagnosed:** a second `db:schema` run right after the first, expecting a clean re-apply,
threw a syntax error mid-file : which only happens if the file being read doesn't match the file
on disk, since the file itself has no syntax error.
**Fix:** `db:schema` now pipes the file over stdin (`psql ... < db/schema.sql`) instead of naming
a path inside the container : stdin reads exactly what the shell just opened, no bind-mount cache
in between.
**Safeguard:** never trust a bind-mounted file for a command run right after editing it in the
same session; pipe it instead, or restart the mount.

---

## The risk-hold veto and the diagnostic label were the same field, and an experiment built to test the label found it

**Expected:** an experiment to isolate what the agent's diagnosis is actually worth : blind the
corpus's `failureReason` (the label `rules-arm.ts` branches on, and the same string the agent's
own case brief reads) and compare all three arms with it hidden but ground truth untouched. Nothing
safety-relevant should move; the veto is a case-data check, not a diagnosis.
**Actual:** `isRiskHold` (`src/domain/case.ts`) reads exactly the field the experiment blinds
(`kase.failureReason === "payment_risk_check_failed"`). With it hidden, the deterministic
risk-hold veto never fires : 4 clamps in the labeled run, 0 in the blinded one : and 4 of the 8
genuinely risk-holding cases were written off by the agent's own (wrong) "unrecoverable" diagnosis
instead of escalating to a human. `write_off_unsupported` didn't catch it either: that gate checks
whether the agent *claimed* an unrecoverable diagnosis, not whether the claim is true, so a
misdiagnosed risk hold that says "unrecoverable" sails through it.
**Why it's dangerous:** this is exactly the failure this project's central rule exists to prevent
: a path where the agent's own (mistaken) judgment ends a case a human was supposed to see, with
no deterministic check reading anything the agent didn't say. It only didn't happen in the
published headline run because the corpus never blinds the label there.
**How diagnosed:** the experiment was built to answer a different question (does diagnosis beat a
lookup table with the label hidden) and this fell out of checking the gate's rule-firing counts
before writing up the result, not from looking for it.
**Fix:** none shipped. Blinding `failureReason` is real, useful evidence for the diagnosis
question and stays as a `--blind-reason` bench flag : but it is now documented as an evaluation
tool only, never a mode to run unattended, and the README states the coupling plainly next to the
number rather than only in this file.
**Safeguard, not yet built:** the real fix is giving risk-hold its own field, independent of the
display error string : a real Razorpay integration would carry it as its own signal on the payment
entity, not folded into `failureReason` the way this corpus's shorthand does. That's a schema and
domain-type change, not a one-line patch, and it's flagged here rather than rushed in.

---

## A tool returned a per-template timing echo, and nobody noticed until a disclosure pass went looking for leaked signals

**Expected:** every signal the agent's tools return is what a real merchant system would expose :
no tool carries ground truth the production shape wouldn't have.
**Actual:** `get_similar_resolved_cases` (`src/persistence/case-repository.ts`, `similarResolved`)
returns `hoursToResolution` for earlier-resolved sibling cases with the same failure reason in the
same run : a legitimate production signal. But the corpus is templated: each template's
ground-truth settle hour is a fixed value (72h, 24h, 14h, 12h, 8h, 6h by template), so a
late-batch case can effectively read its template's exact recovery timing through its resolved
siblings. It leaks *when*, not *what action*, and it is agent-arm-only : but on this corpus it is
a crisper signal than production would give.
**Why it's dangerous:** silent ground-truth leakage into a measured arm is exactly how a
benchmark number gets inflated without anyone noticing; the whole project's credibility rests on
the agent winning or losing on real reasoning.
**How diagnosed:** a deliberate pass over every tool's output for anything the ground truth
determines, after two earlier leaks in this repo were already caught the same way.
**Fix:** disclosed, not removed : the signal is production-defensible and the recorded bench was
generated with it present. The README states the echo explicitly next to the evaluation section.
**Safeguard:** the disclosure; and the real fix for a future corpus is diversifying settle hours
per template (per-case jitter on the ground-truth `atHour`), which would blur the echo without
touching any tool.

---

## The spend cap was guessing, and it guessed 2.1x low

**Expected:** `AGENT_SESSION_CAP_USD` bounds what a session can spend, and the cost figures this
repo quotes are close enough to the bill to be worth printing.
**Actual:** `agent/budget.ts` charged a flat `costPerCallUsd = 0.0025` per call and never read a
single token count. Its own comment claimed the constant was "calibrated against a real measured
run," which was not true of anything in the repo : there was no measurement to calibrate against,
because no code path had ever looked at a usage block. Metered against the provider for the first
time, a call on this workload costs **$0.0052**. The constant was **2.1x low**, so the cap
permitted roughly twice the spend it advertised, and every cost figure the README carried was an
underestimate of the same factor.
**Why it's dangerous:** a budget guard that under-charges is worse than none, because it reports a
comfortable number while the real bill runs ahead of it. This is the same class of error as the
fallback-constant entry above : a number the codebase asserted about itself, that nothing checked.
And it was quoted publicly, in a README section whose entire purpose was honesty about cost.
**How diagnosed:** writing the meter, then comparing what it reported on a live 8-case slice
against what the old constant would have charged for the same 89 calls : $0.4627 against $0.2225.
**Fix:** tokens are read off the terminal `finish` part of the stream (and off the result on the
non-streaming path), priced with declared per-million rates from `AGENT_USD_PER_M_INPUT` /
`AGENT_USD_PER_M_OUTPUT`. A call whose response carries no usage block is counted in
`callsWithoutUsage` and still charged the flat fallback : a silent zero would both understate the
bill and disarm the cap, which is the failure this entry is about. The five committed seed runs
predate the meter, so their cost is stated as not measured rather than back-filled by
extrapolation.
**Safeguard:** `tests/budget.test.ts` pins the nested v3/v4 and flat v2 usage shapes, the stream
path, a reported zero as distinct from a missing block, the fallback charge, and the cap refusing
the next call once measured spend passes it.
