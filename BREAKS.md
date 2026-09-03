# What broke, and how we got out

Kept as a live log during the build, not reconstructed at the end. Full internal version
(including the pre-pivot authorization-layer project this one replaced) is in
`context/BREAKS.md`, gitignored; this is the Recovery Room subset that matters to a reader.

---

## Day 0 — the stack on paper was wrong on four counts before a line was written

Probed every external assumption against the live APIs instead of trusting the plan.
- The planned model (`gemini-2.5-flash`) was retired — `404`, points at `gemini-3.6-flash`.
- The Gemini key was quota-capped: a deliberate 25-call burst got 16 successes then 9 straight
  429s. The eval needs ~700 calls/run. Unusable.
- Every route to a paid Gemini key was closed — billing signup failed (`OR_BACR2_44`), and
  Google's own docs say the $300 trial credit cannot be spent on the Gemini API at all.
- The planned headline failure code, `do_not_honor`, is an ISO-8583 code, not a Razorpay
  `error_reason` value. A Razorpay reviewer would have caught a fabricated code immediately.

**Fix:** moved to OpenRouter (no minimum, no cloud billing account). Corrected the corpus to
Razorpay's real `error_reason` vocabulary. **Unexpected upside from the same sweep:**
`GET /v1/payments/downtimes` answers on the test key with real data — that became the spine of
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
enforced unique at all — two orders with the same receipt both succeed. Payment links are the
opposite: `reference_id` duplicates are rejected server-side.
**Why it's dangerous:** the reconciliation read runs exactly in the window the list index hasn't
caught up — "not found" would have been read as "safe to retry," producing two real orders for
one attempt, precisely when the gateway is already unhealthy.
**Fix:** the attempt row's own `UNIQUE idempotency_key` is the authority, not Razorpay's list.
Ambiguous creates land in `AWAITING_RECONCILIATION` and are never concluded from list absence.
Payment link duplicate-reference errors are now treated as success-plus-lookup.
**Safeguard:** a read used to decide "did my write land" is tested with zero delay between write
and read — a test that sleeps is testing a different system than production runs.

---

## The risk-hold veto was wired to nothing

**Expected:** the safety gate independently vetoes any risk-flagged payment.
**Actual:** the veto read `proposal.diagnosisRootCause === "risk_hold"` plus an optional
`riskHoldForCase` callback that was never actually passed at any construction site. A payment the
agent misdiagnosed as `soft_decline` would sail straight through to an auto-retry.
**Fix:** `isRiskHold(kase)` reads Razorpay's own `payment_risk_check_failed` reason directly off
the case — independent of what the agent concludes, wired at every pipeline construction site.
**Safeguard:** the pipeline suite runs the gate against a misdiagnosed risk case and asserts zero
gateway calls.

---

## `WRITE_OFF` could bury a risk hold with no human ever seeing it

**Expected:** `CAUTION_RANK` — the gate's directional ordering — meant "never less cautious"
covered every guardrail, including risk holds.
**Actual:** the first exhaustive property-test run failed immediately. `WRITE_OFF` and `ESCALATE`
rank equal on `CAUTION_RANK` (neither moves money), so a risk-hold case the agent proposed to
`WRITE_OFF` passed the rank check and was allowed — closed permanently, no reviewer ever notified.
**Why:** the ladder measures how much money moves. `ESCALATE` and `WRITE_OFF` are identical on
that axis and opposite on the axis that actually mattered here — whether a human sees the case.
**Fix:** the risk-hold veto no longer consults the rank at all: `if (riskHold && kind !== "ESCALATE")`.
**Safeguard:** two tests pin it, one exhaustive, one naming the exact bug. `CAUTION_RANK` is now
documented as a money-movement ordering only — anything asking "must a human see this" must be
an explicit check, never inferred from rank.

---

## The bench was handing the agent its own answer key

**Expected:** the agent beats a fixed retry schedule because it diagnoses better.
**Actual:** it beat it because `ground-truth-resolver.ts` wrote the corpus's answer straight into
the failed attempt's `outcome_detail` — strings like "too early (recovers at +72h)". That column
is exactly what `get_this_case_prior_attempts` feeds back to the agent on its next turn; the
recorded reasoning quotes it back verbatim.
**Fix:** every failed verdict now returns a flat `"payment declined"`, regardless of why.
**What it cost:** the honest number after the fix was 45.0% agent vs 46.7% fixed — the agent
*losing*. The old headline is retired and must never be quoted again.
**Safeguard:** a test drives the resolver through every failure branch and asserts the detail
matches no recovery-hour or corrective-hint pattern.

---

## The bench graded a decision at the moment it was made, not the moment it would settle

**Expected:** a `RETRY_SCHEDULED +72h` is graded 72 hours out.
**Actual:** `GroundTruthResolver.resolve()` was called synchronously the instant the action was
created, so a `+72h` retry was judged at hour 0 and failed before the sim clock had moved. An
outreach was graded the instant it was sent, before the customer could plausibly have acted.
**What that did:** it punished exactly the behaviors the agent exists for — timing a retry,
switching rails. Every `card_expired` case correctly proposed a nudge, was graded a failure
before the customer could respond, and the agent — correctly told not to repeat a failed move —
re-planned onto the wrong action and escalated. The fixed schedule, which never reads feedback,
was immune.
**Fix:** the resolver now grades an action at the hour it actually settles.
**What it cost:** 45.0% → 65.0% agent recovery rate on the same recorded turns, zero new model
calls needed to re-measure. The fixed arm's own count was unchanged, only faster.
**Safeguard:** four tests pin the settlement-timing semantics directly. General rule adopted:
replay every recorded turn through a from-scratch re-simulation and read the actual attempt
chains in Postgres before trusting any bench headline — neither this bug nor the one above would
have been caught from the summary metrics alone.

---

## A tuning experiment hit 100% of its own ceiling — and wasn't shipped

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
the three changes present — landed at 68.3% vs 46.7%, inside noise of the pre-experiment result,
and shipped that instead. The overfit run's cache is archived, not deleted, so the shape of an
overfit result on this corpus isn't lost.
**Safeguard:** a ~20pp gap or 100%-of-ceiling recovery on this bench is now a standing signal to
distrust the run, not celebrate it — set and written down before running the experiment, not
rationalized after seeing the number.

---

## The fixed schedule was a strawman; a 6-line switch beats the agent

**Expected:** the shipped 21.6pp gap (68.3% vs 46.7%) was the honest measure of judgment.
**Actual:** it wasn't. The fixed-schedule arm only ever proposes a retry — it structurally loses
every case needing a different rail (a payment link, a nudge), regardless of any timing logic.
The gap was "three rails beat one," not "diagnosis beats a calendar." A third arm transcribing the
agent's own system-prompt playbook into a 7-line `switch` on `error_reason` — no model, ₹0 —
recovered 43/60 (71.7%, ₹64,457), beating the agent's 41/60.
**Why:** the corpus was 7 templates and the playbook was 7 lines, one per template. A table built
from the same lines the agent already had wins, because there's nothing left for judgment to add
on a fully-enumerated taxonomy.
**How we got out (this session's own audit, on top of the earlier one):** rather than accept the
loss, went hunting for *why* judgment wasn't adding anything, and found two compounding bugs: the
downtime tool matched on payment method instead of the specific issuing bank, so it returned
`matched: true` for every card case regardless of which bank — writing fabricated "the bank is
down" claims into the audit trail on 43 of 54 downtime diagnoses in the recorded run — and the
root-cause playbook was baked into the system prompt, so the model was retrieving the table
rather than reasoning to it. Fixed the tool (issuer-specific match, separate from method-wide
context, with a real regression test — the old one had silently varied two variables at once and
missed the bug). Moved the playbook behind a tool call the model must choose to invoke. Rebuilt
the corpus with real, stated ambiguity: a 20% share of generic declines actually downtime-driven,
and a genuine history-trend split (not a record count) on `insufficient_funds`. Re-ran clean:
agent 42/60 (₹60,458) vs rules 43/60 (₹59,457) — a near-tie on the action-policy race, honestly
reported as such — plus **71.7% root-cause diagnosis accuracy, a number the rules table cannot
produce at all**, since it never diagnoses anything.
**Safeguard:** the rules table ships as a permanent third arm, reported by default, never hidden.
Root-cause accuracy is graded separately from the action taken specifically so a lookup table's
structural win on one axis can't be used to claim (or hide) a loss on the other.

---

## A duplicate webhook could permanently drop a real capture

**Expected:** `razorpay_webhooks.event_id` dedupe means a redelivery is a safe no-op.
**Actual:** it assumed the first delivery *finished*. If the process died between recording the
event id and settling the attempt, the attempt stayed `PENDING` — and a redelivery of the same
event id hit the dedupe check and did nothing, discarding the only remaining signal that the
money had landed.
**Fix:** a redelivered event id is only a true no-op once the attempt it names has actually
reached a terminal state. Still `PENDING` or `AWAITING_RECONCILIATION`: the handler settles from
the redelivered event instead of trusting the dedupe alone.
**Safeguard:** a regression test seeds exactly that crash window and asserts the redelivery
settles it. General rule: event-id dedupe on a settlement webhook has to be paired with a check
that the thing it settles actually reached a terminal state, or a redelivery becomes
indistinguishable from "already handled" when it's really "never finished."
