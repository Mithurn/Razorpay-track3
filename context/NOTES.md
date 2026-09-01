# Decision log

## 2026-09-02 — Pivot from Aegis to Recovery Room (Track 3)

**Decision.** Abandon the Aegis product (authorization/trust layer for agentic payments) and
build a payment-recovery agent for Track 3 instead. New repo, greenfield, reusing ~40% of
Aegis's backend.

**Why.** Aegis's own measured result: the AI arm (an "investigator" LLM) scored *worse* than
the deterministic rules arm (recall 1.000 → ~0.14). Root cause is structural, not a prompt bug:
authorization is deterministic by nature (signatures, caps, allowlists, nonces), so Aegis built
an excellent deterministic system and then had to invent a job for the AI that the system did
not need. That is a criterion-3 failure on Razorpay's rubric ("the right tool in the right
place, and where you chose not to use one"). Payment recovery is a problem where an agent
genuinely earns its place: reading a messy failure + customer context and choosing a contextual
intervention (timing vs a new rail vs give up) is not something a threshold can do.

**Architecture.** A real bounded tool-using agent owns the recovery *strategy*; a pure
deterministic safety gate fences it (can force ESCALATE, never loosen — same `max()`-over-lattice
shape as Aegis's gate). The LLM has no path to move money past an attempt cap, a ₹ exposure cap,
or twice. Not a scripted classify→switch pipeline (rejected — not agentic enough), not a
free-for-all (rejected — that is what sank Aegis's investigator: slow, unpredictable, 3–6 min
per case).

**Kept from Aegis:** executor state machine + reconciliation (`AWAITING_RECONCILIATION`,
exactly-once, CAS), Razorpay client + HMAC webhook verification, append-only ledger discipline
(DB-role enforced), BullMQ queue pattern, metrics scaffolding, Fastify + Vite shell, fail-closed
instincts, BREAKS.md discipline. **Cut:** mandate signing, verifier, the 9-tool investigator,
the gate lattice, the adversarial corpus, the buyer/browser demo agents.

**Stack change:** added Mastra (`@mastra/core`) for the agent loop — matches the team's
`superkalam-ai` production codebase. Model provider is `@ai-sdk/google` with a plain
`GEMINI_API_KEY` (no GCP/Vertex). Aegis's hand-rolled Gemini/Groq clients dropped.

**Deadline:** 5 September 2026. See `context/PROJECT.md` for the 3-day plan.

---

*(Older Aegis decisions live on branch `phase-4-frontend` of the previous `RazorPay-build` repo.
The Razorpay test-mode facts that still apply — card `4111...` fails on this account, netbanking
mock page has a Success/Failure button — are in `context/BREAKS.md`.)*
