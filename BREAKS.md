# What broke, and how we got out

Live engineering failure log for RecoveryOps. Entries were added as failures were discovered during implementation, testing, benchmarking, and final audit — not polished after the fact.

> Figures inside individual entries are point-in-time measurements. Current published numbers are always in [`README.md → Evaluation`](./README.md#evaluation).

---

## Summary

### Safety & financial control
1. **Risk-hold veto wasn't wired** — optional callback never passed; misdiagnosed risk-flagged payments could bypass human review
2. **WRITE_OFF could close risk holds** — `CAUTION_RANK` measured money movement, not human visibility
3. **Risk-hold veto couples to `failureReason`** — blinding the label (benchmark experiment) disables the deterministic veto

### Benchmark integrity
4. **Benchmark leaked answers through prior-attempt data** — agent read recovery hints from `outcome_detail`
5. **Benchmark graded actions at creation, not settlement** — punished timing and rail-switching
6. **Fixed baseline was structurally unfair** — only proposed retries; lost all link/nudge cases
7. **Downtime matching was incorrect** — matched on method (card) instead of specific issuer
8. **Degraded diagnoses fabricated as `technical`** — null → "technical" inflated root-cause accuracy

### Reliability
9. **Duplicate webhook could drop a real capture** — dedupe assumed first delivery finished
10. **Human escalation was a dead end** — directives were written but never read

### Infrastructure
11. **Benchmark cache replayed stale recordings** — zero model calls looked like a valid result
12. **Schema bind-mount served truncated file** — GRANT statements past line 97 were skipped
13. **Spend cap charged a flat constant, 2.1× low** — no code path had ever read a token count

### Found after buildathon deadline — fixed and re-benchmarked
14. **Agent's evidence tool only ever showed it winning** — `get_similar_resolved_cases` filtered to `lane = 'RECOVERED'`; escalated and written-off cases were invisible
15. **Blind-reason control silently breaks a second tool** — `get_similar_resolved_cases` also keys on `failureReason`; blinding collapses it into an undifferentiated pool

---

## Detailed log

---

### Day 0 — Stack assumptions

Probed every external assumption against the live APIs before writing a line of product code.

- The planned model (`gemini-2.5-flash`) was retired — 404, redirects to `gemini-3.6-flash`.
- The Gemini quota-cap made the key unusable for a ~700-call eval run.
- The planned failure code (`do_not_honor`) is ISO-8583, not a Razorpay `error_reason` value.

**Fix:** moved to OpenRouter. Corrected corpus to Razorpay's real `error_reason` vocabulary. Unexpected upside: `GET /v1/payments/downtimes` responds on the test key with real data — that became the backbone of the bank-downtime diagnosis feature.

**Safeguard:** model ID is always an env override; a 30-second quota probe runs before any unattended key is trusted.

---

### `receipt` is not an idempotency key, and the order list lags

**What happened:** an order confirmed to exist via `GET /orders/:id` came back `count: 0` from the filtered list query. Razorpay's order list index is eventually consistent (lag of minutes, unbounded), even though direct-by-id reads are immediate. Separately, `receipt` has no server-side uniqueness at all.

**Why it mattered:** "not found" would have been read as "safe to retry," producing two real orders for one attempt, precisely when the gateway was already unhealthy.

**Fix:** the attempt row's own `UNIQUE idempotency_key` is the authority. Ambiguous creates land in `AWAITING_RECONCILIATION` and are never concluded from list absence. For payment links, `reference_id` uniqueness is enforced server-side; for orders there is no equivalent — documented as the one place idempotency depends on Razorpay's guarantees rather than only ours.

**Safeguard:** a test reads immediately after write with zero delay — if it passes, the system is testing a different property than production relies on.

---

### Risk-hold veto was wired to nothing

**What happened:** the veto read `proposal.diagnosisRootCause === "risk_hold"` plus an `riskHoldForCase` callback that was never passed at any construction site. A misdiagnosed case sailed straight through to an auto-retry.

**Fix:** `isRiskHold(kase)` reads Razorpay's `payment_risk_check_failed` reason directly from the case — independent of what the agent concludes, wired at every pipeline construction site.

**Safeguard:** pipeline suite runs the gate against a misdiagnosed risk case and asserts zero gateway calls.

---

### `WRITE_OFF` could permanently close a risk hold with no human review

**What happened:** the first exhaustive property test failed immediately. `WRITE_OFF` and `ESCALATE` rank equal on `CAUTION_RANK` (neither moves money), so a risk-hold case the agent proposed to `WRITE_OFF` passed the rank check and was allowed — closed permanently, no reviewer notified.

**Why:** the ladder measures money movement. `ESCALATE` and `WRITE_OFF` are identical on that axis and opposite on whether a human sees the case.

**Fix:** the risk-hold veto no longer consults the rank: `if (riskHold && kind !== "ESCALATE")`. `CAUTION_RANK` is now documented as money-movement ordering only — "must a human see this" requires an explicit check, never a rank inference.

**Safeguard:** two tests pin it — one exhaustive property test, one naming the exact bug.

---

### Benchmark was handing the agent its answer key

**What happened:** `ground-truth-resolver.ts` wrote the corpus answer straight into the failed attempt's `outcome_detail` — strings like `"too early (recovers at +72h)"`. That column is exactly what `get_this_case_prior_attempts` feeds back to the agent; recorded reasoning quotes it verbatim.

**Fix:** every failed verdict now returns a flat `"payment declined"`, regardless of why.

**Cost:** the honest number after the fix was 45.0% agent vs 46.7% fixed — the agent losing. The old headline is retired.

**Safeguard:** a test drives the resolver through every failure branch and asserts the detail matches no recovery-hour or corrective-hint pattern.

---

### Benchmark graded decisions at creation, not settlement

**What happened:** `GroundTruthResolver.resolve()` was called synchronously the instant the action was created. A `RETRY_SCHEDULED +72h` was judged at hour 0 and failed before the sim clock moved.

**What that did:** punished exactly the behaviours the agent exists for — timing a retry, switching rails. The fixed schedule, which never reads feedback, was immune.

**Fix:** the resolver now grades an action at the hour it actually settles.

**Cost:** 45.0% → 65.0% agent recovery rate on the same recorded turns, zero new model calls needed.

**Safeguard:** four tests pin the settlement-timing semantics directly.

---

### A tuning experiment hit 100% of its ceiling — and wasn't shipped

Three targeted changes (a customer-history signal, a corpus template, two prompt lines) produced 73.3% agent vs 46.7% fixed in one paid re-record. Looked too good.

**What was wrong:** the corpus template anchored a case to a real payday — effectively handing the agent a dated signal the corpus wasn't supposed to carry. The whole result was corpus-specific overfitting, not a generalizable improvement.

**Fix:** changes reverted. The published numbers are the pre-tuning result. The tuning attempt itself is documented as a reminder that "this looks too good" is the right time to look harder.

---

### Fixed baseline was structurally unfair

**What happened:** the fixed arm only ever proposed `RETRY_SCHEDULED`. Cases where the ground truth was `PAYMENT_LINK` or `CUSTOMER_NUDGE` were lost by construction.

**Fix:** the fixed arm now mirrors a real dunning schedule: retry at T+24h, retry at T+72h, payment link at T+120h, escalate thereafter. It's still weaker than the agent but for the right reasons.

---

### Downtime matching was incorrect

**What happened:** the bank-downtime signal matched on `method = "card"` rather than the specific `issuer = "Bank of India"`. A Bank of India outage would suppress action on every card case, not just the affected issuer.

**Fix:** matching is now issuer-specific. The corpus's downtime pairing (Bank of India cases) tests this directly.

---

### Degraded diagnoses fabricated as `technical`

**What happened:** when the agent failed to produce a valid `rootCause` (timeout, malformed output), the code fell through to a default of `"technical"`. Root-cause accuracy was computed including these fabricated values — inflating the number by counting non-answers as correct answers.

**Fix:** a degraded turn returns `diagnosisRootCause: null`. Accuracy is computed as `correct / total` where null is a miss, not excluded from the denominator.

---

### Duplicate webhook could silently drop a real capture

**What happened:** the dedup check assumed the first delivery had finished settling. A redelivery that arrived while the first was still in-flight was a silent no-op, even if the first never wrote a settlement.

**Fix:** the handler checks attempt status after the dedup write and proceeds if still unresolved.

**Safeguard:** `"settles a redelivered event whose first delivery never finished settling"` in the webhook integration tests.

---

### Human escalation was a dead end

**What happened:** the operator directive table was written but never read. An escalated case sent to retry by an operator just sat there.

**Fix:** the pipeline reads `pendingDirective()` on every turn before calling the agent — a directive short-circuits the agent call entirely and applies the directed action directly.

---

### Benchmark cache replayed stale recordings silently

**What happened:** the cache key was `customerRef#attemptNo` only — no model, no seed, no size. A same-shape re-run with a different model or changed prompt replayed the old recording at zero model calls, showing a "valid" result that was actually the previous model's output.

**Fix:** cache key includes model ID, seed, and corpus size. A different model needs its own recording. `--mock` replays only; without it, the agent always runs live.

---

### Schema bind-mount served a truncated file

**What happened:** the Docker bind-mount truncated `db/schema.sql` at line 97. GRANT statements below that line — including the `recovery_app` role grants — were never applied. The append-only guarantee existed in the file but not in the database.

**Fix:** schema is now applied via `docker compose exec` piping the file directly, not via a bind-mount volume.

**Safeguard:** `tests/append-only.integration.test.ts` connects as `recovery_app` and asserts UPDATE is refused. If the grant wasn't applied, this test fails.

---

### Spend cap charged a flat constant, 2.1× low

**What happened:** `agent/budget.ts` charged `$0.0025` per call and never read a token count. Measured against the provider, a call on this workload costs `$0.0052`. The cap permitted roughly twice the spend it advertised, and every cost figure in the README was an underestimate.

**Fix:** tokens are read off the terminal `finish` part of the SDK stream. Rates are declared via `AGENT_USD_PER_M_INPUT` / `AGENT_USD_PER_M_OUTPUT`. A call with no usage block is counted in `callsWithoutUsage` and still charged the flat fallback — a silent zero would understate the bill and disarm the cap.

**Safeguard:** [`tests/budget.test.ts`](./tests/budget.test.ts) pins both usage shapes, the stream path, a reported zero vs a missing block, the fallback charge, and the cap refusing the next call once measured spend passes it.

---

### Agent's evidence tool only ever showed it winning *(found post-deadline)*

**What happened:** `get_similar_resolved_cases` filtered on `c.lane = 'RECOVERED'`. Escalated and written-off cases were invisible no matter how many shared the same failure reason — survivorship bias in the model's own evidence.

**Why it mattered:** this pushes the agent toward "this looks recoverable" on genuinely ambiguous cases, because the only history it can see is history that worked out. Every genuinely-unfunded account being misdiagnosed as `insufficient_funds` is exactly the failure shape this bias would produce.

**Fix:** query now matches any case in `TERMINAL_LANES`. Mid-investigation cases remain excluded.

**Measured effect, seed 42:**

| | Before | After |
|---|---:|---:|
| Recovered | 33/60 (55.0%) | 34/60 (56.7%) |
| ₹ recovered | ₹51,967 | ₹53,966 |
| Degraded | 1/60 | 0/60 |

The fix made the agent better: cases that previously reached `WRITTEN_OFF` on a misplaced "unrecoverable" conclusion now correctly escalate. All five published seeds were re-run; the README numbers are the fixed ones.

**Safeguard:** `"similarResolved also surfaces a failed attempt from a case that ended escalated, not just recovered ones"` in the pipeline integration tests.

---

### Blind-reason control silently breaks a second tool *(found post-deadline)*

**What happened:** `get_similar_resolved_cases` keys on `failureReason`. Under `--blind-reason` every case shares the same generic string, so the query returns an undifferentiated mix of every failure type rather than cases with the same true root cause. The already-documented risk-hold veto coupling is a third signal broken by blinding.

**Why it matters:** the blind-reason number is supposed to isolate reasoning from label-reading. Part of any score drop in blind mode reflects a crippled evidence tool, not weaker reasoning.

**Measured:** fixing the survivorship bias raised the labeled numbers (55.0% → 56.7%) and lowered the blind ones (45.0% → 38.3%) in the same run from the same fix. The agent still leads fixed/rules blind (38.3% vs 33.3%), just by less than the pre-fix number suggested.

**Fix:** not made. A correct fix means giving `similarResolved` something to bucket on that survives blinding (method + instrument + amount band) without leaking ground truth — a schema and corpus change, not a query tweak. The blind-mode numbers are published with this confound disclosed.
