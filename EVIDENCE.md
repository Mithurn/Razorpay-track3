# Claim-to-evidence index

Every number in the README mapped to the exact command that reproduces it.
All figures replay byte-for-byte from committed cache files — no live model call needed.

---

## Headline evaluation table (README → Evaluation)

| Claim | Reproducing command |
|-------|---------------------|
| Agent 34/60, 56.7%, ₹53,966, 73.3% root-cause accuracy | `npm run bench -- --mock --seed 42` |
| Fixed 20/60, 33.3%, ₹31,480 | same run — three arms together |
| Rules 36/60, 60.0%, ₹56,464 | same run — three arms together |
| Blind-reason agent 23/60, 38.3%, ₹37,477 | `npm run bench -- --mock --seed 42 --blind-reason` |

The `--mock` flag replays from `bench/.cache/` — no network, no API key required.

---

## Cross-seed table (README → Cross-seed consistency)

| Seed | Agent rate | Rules rate | Reproducing command |
|------|-----------|-----------|---------------------|
| 42 | 56.7% | 60.0% | `npm run bench -- --mock --seed 42` |
| 7 | 51.7% | 58.3% | `npm run bench -- --mock --seed 7` |
| 13 | 61.7% | 63.3% | `npm run bench -- --mock --seed 13` |
| 99 | 56.7% | 60.0% | `npm run bench -- --mock --seed 99` |
| 2024 | 56.7% | 60.0% | `npm run bench -- --mock --seed 2024` |

---

## Safety gate (README → Safety gate)

| Claim | Where to look |
|-------|---------------|
| Nine gate rules | `src/safety/safety-gate.ts` — `safetyGate()` |
| Exposure cap ₹5,000 | `src/safety/safety-gate.ts` `DEFAULT_LIMITS.maxExposurePaise` |
| Max 4 attempts | `src/safety/safety-gate.ts` `DEFAULT_LIMITS.maxAttempts` |
| Contact cooldown 24 h | `src/safety/safety-gate.ts` `DEFAULT_LIMITS.contactCooldownHours` |
| Gate clamped risk-hold proposals | `npm run decision-table` — see `risk_hold` rows |

---

## Agent step budget

| Claim | Reproducing command |
|-------|---------------------|
| Step budget p50/p95/max, degrade rate | `npm run decision-table` |
| Bounded loop — deadline + forced conclusion | `src/agent/recovery-agent.ts` |

---

## Test count

| Claim | Reproducing command |
|-------|---------------------|
| 245 tests pass | `npm test` |
| 109 unit tests, zero services, ~2 s | `npm run test:unit` |
| Integration tests (Postgres + Redis) | `npm test` with `DATABASE_URL` and `REDIS_URL` set |

---

## Spend figure (README → Model spend)

| Claim | Source |
|-------|--------|
| ₹17,915 recovered per $1 spent | Live run output; re-run with `npm run bench -- --seed 42` (needs API key + DB). The committed `.cache/` file logs `toolCalls` per turn but not token counts — those require a live run. |

---

## Append-only audit trail

| Claim | Reproducing command |
|-------|---------------------|
| `recovery_app` role cannot UPDATE or DELETE | `npm run verify-audit` — runs UPDATE + DELETE probes as the app role, checks sequence gaps, exits 0 only if all pass |
| Full ordered audit tape for a case | `npm run explain -- <caseId>` — prints every event including suppressed types (AUDIT_GAP, NUDGE_QUEUED, etc.) |

---

## Survivorship-bias fix (BREAKS.md entry)

| Claim | Reproducing command |
|-------|---------------------|
| Pre-fix seed 42: 33/60 → post-fix 35/60 | Pre-fix number in BREAKS.md; post-fix: `npm run bench -- --mock --seed 42` |
| Blind-reason: pre-fix 45.0% → post-fix 38.3% | Same comparison; blind run: `npm run bench -- --mock --seed 42 --blind-reason` |
