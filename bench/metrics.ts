import type { Attempt } from "../src/domain/attempt.js";
import type { RecoveryCase } from "../src/domain/case.js";
import type { GroundTruth } from "./corpus.js";

export type CaseRecord = {
  kase: RecoveryCase;
  attempts: Attempt[];
  groundTruth: GroundTruth;
  simHoursToResolution: number | null;
};

export type ArmMetrics = {
  arm: string;
  cases: number;
  recovered: number;
  recoveryRate: number;
  recoveredPaise: number;
  recoverablePaise: number;
  meanAttemptsPerRecovery: number;
  meanHoursToRecovery: number;
  escalations: number;
  escalationRate: number;
  overNudges: number;
  overNudgeRate: number;
  // null for an arm that never diagnoses (fixed, rules) — reported as "no diagnosis," not a
  // misleading number computed from a fallback value that was never meant as a real answer.
  rootCauseAccuracy: number | null;
  // Cases whose first turn reached no diagnosis at all. Counted against rootCauseAccuracy rather
  // than excluded from it: dropping them shrinks the denominator, which flatters the agent.
  undiagnosed: number;
};

export type ExceptionRow = {
  customerRef: string;
  failureReason: string;
  amountPaise: number;
  lane: string;
  groundTruthNote: string;
  attempts: string;
};

// What the agent arm actually cost to run, read off the provider's own usage blocks. Only a live
// run produces one — a --mock replay makes no model calls, so there is nothing to report and the
// section is omitted rather than printed as zero.
export type SpendSummary = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  callsWithoutUsage: number;
  usdUsed: number;
  usdPerMInput: number;
  usdPerMOutput: number;
};

// Tool-call (step) distribution across all agent turns in a run.
export type StepDistribution = {
  turns: number;
  degraded: number;
  p50: number;
  p95: number;
  max: number;
};

// Per-run safety ledger: how many gate evaluations fired, skipped, or clamped, and which rule.
export type GateCounters = {
  total: number;
  byOutcome: { outcome: string; rule: string | null; count: number }[];
};

const div = (a: number, b: number) => (b === 0 ? 0 : a / b);

function moneyMoves(a: Attempt): boolean {
  return a.action !== "ESCALATE" && a.action !== "WRITE_OFF" && a.status !== "SKIPPED";
}

// Graded separately from the action taken — a lookup table can win the action-policy comparison
// by construction, but has no concept of the cause at all. null means the loop degraded before
// reaching a diagnosis, which is a miss, not an exemption.
function firstAttemptRootCause(r: CaseRecord): string | null {
  return r.attempts.find((a) => a.attemptNo === 1)?.rootCause ?? null;
}

export function scoreArm(arm: string, records: CaseRecord[]): ArmMetrics {
  const recovered = records.filter((r) => r.kase.lane === "RECOVERED");
  const escalated = records.filter((r) => r.kase.lane === "ESCALATED");
  // A payment link is outreach too — the customer is asked to act, same false-positive exposure
  // as a nudge. Counting only CUSTOMER_NUDGE understated who was actually contacted.
  const contacted = records.filter((r) => r.attempts.some((a) => a.action === "CUSTOMER_NUDGE" || a.action === "PAYMENT_LINK"));

  const attemptsToRecovery = recovered.map((r) => r.attempts.filter(moneyMoves).length);
  const hoursToRecovery = recovered
    .map((r) => r.simHoursToResolution)
    .filter((h): h is number => h !== null);

  // fixed/rules never diagnose — null, not a fallback-coincidence number.
  const rootCauseAccuracy =
    arm === "agent"
      ? div(records.filter((r) => firstAttemptRootCause(r) === r.groundTruth.trueCause).length, records.length)
      : null;
  const undiagnosed = records.filter((r) => firstAttemptRootCause(r) === null).length;

  return {
    arm,
    cases: records.length,
    recovered: recovered.length,
    recoveryRate: div(recovered.length, records.length),
    recoveredPaise: recovered.reduce((s, r) => s + r.kase.recoveredPaise, 0),
    recoverablePaise: records.filter((r) => r.groundTruth.recoverable).reduce((s, r) => s + r.kase.amountPaise, 0),
    meanAttemptsPerRecovery: div(
      attemptsToRecovery.reduce((a, b) => a + b, 0),
      attemptsToRecovery.length,
    ),
    meanHoursToRecovery: div(
      hoursToRecovery.reduce((a, b) => a + b, 0),
      hoursToRecovery.length,
    ),
    escalations: escalated.length,
    escalationRate: div(escalated.length, records.length),
    overNudges: contacted.filter((r) => r.groundTruth.selfRecovers).length,
    overNudgeRate: div(contacted.filter((r) => r.groundTruth.selfRecovers).length, records.length),
    rootCauseAccuracy,
    undiagnosed,
  };
}

export function exceptionList(records: CaseRecord[]): ExceptionRow[] {
  return records
    .filter((r) => r.kase.lane !== "RECOVERED")
    .map((r) => ({
      customerRef: r.kase.customerRef,
      failureReason: r.kase.failureReason,
      amountPaise: r.kase.amountPaise,
      lane: r.kase.lane,
      groundTruthNote: r.groundTruth.note,
      attempts: r.attempts.map((a) => `${a.action}:${a.status}`).join(" -> ") || "none",
    }));
}

function spendLines(spend: SpendSummary, agent: ArmMetrics): string[] {
  const pad = (label: string, v: string) => `  ${label.padEnd(28)}${v.padStart(16)}`;
  // Counts, not money — en-IN lakh grouping on a token total reads as a typo.
  const n = (v: number) => v.toLocaleString("en-US");
  return [
    "",
    `model spend — agent arm, measured from provider usage:`,
    pad("model calls", n(spend.calls)),
    pad("input tokens", n(spend.inputTokens)),
    pad("output tokens", n(spend.outputTokens)),
    // Surfaced even at zero: a nonzero count means part of the bill below is the flat per-call
    // fallback rather than metered tokens, and the reader has to know which.
    pad("calls with no usage block", n(spend.callsWithoutUsage)),
    pad(`cost @ $${spend.usdPerMInput}/$${spend.usdPerMOutput} per M`, `$${spend.usdUsed.toFixed(4)}`),
    pad("cost per recovery", agent.recovered === 0 ? "—" : `$${(spend.usdUsed / agent.recovered).toFixed(4)}`),
    pad("₹ recovered per $1 spent", spend.usdUsed === 0 ? "—" : `₹${Math.round(agent.recoveredPaise / 100 / spend.usdUsed).toLocaleString("en-IN")}`),
  ];
}

function gateLines(g: GateCounters): string[] {
  const pad = (label: string, v: string) => `  ${label.padEnd(28)}${v.padStart(16)}`;
  const lines = [``, `safety gate — ${g.total} evaluations across agent arm:`];
  for (const row of g.byOutcome) {
    const label = row.rule ? `${row.outcome} · ${row.rule}` : row.outcome;
    lines.push(pad(label, String(row.count)));
  }
  return lines;
}

function stepLines(s: StepDistribution): string[] {
  const pad = (label: string, v: string) => `  ${label.padEnd(28)}${v.padStart(16)}`;
  const degradeRate = s.turns > 0 ? ((s.degraded / s.turns) * 100).toFixed(1) : "0.0";
  return [
    "",
    `step budget — agent turns (tool calls per turn):`,
    pad("turns", String(s.turns)),
    pad("p50 tool calls", String(s.p50)),
    pad("p95 tool calls", String(s.p95)),
    pad("max tool calls", String(s.max)),
    pad("degrade rate", `${degradeRate}% (${s.degraded}/${s.turns})`),
  ];
}

export function formatReport(
  agent: ArmMetrics,
  fixed: ArmMetrics,
  exceptions: ExceptionRow[],
  rules?: ArmMetrics,
  exceptionArm?: string,
  spend?: SpendSummary,
  steps?: StepDistribution,
  gates?: GateCounters,
): string {
  const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN")}`;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const arms = [agent, fixed, ...(rules ? [rules] : [])];
  // Wide enough for the longest cell ("— (no diagnosis)", 17 chars) plus a real gap to the next
  // column — padStart(12) let that string butt straight up against the next column with no
  // separator at all.
  const col = (n: number | string) => String(n).padStart(20);
  const row = (label: string, get: (m: ArmMetrics) => string) => `${label.padEnd(26)}${arms.map((m) => col(get(m))).join("")}`;

  const lines = [
    rules ? "Recovery Room — three-arm evaluation" : "Recovery Room — two-arm evaluation",
    "",
    row("", (m) => m.arm),
    row("cases", (m) => String(m.cases)),
    row("recovered", (m) => String(m.recovered)),
    row("recovery rate", (m) => pct(m.recoveryRate)),
    row("₹ recovered (bench)", (m) => rupees(m.recoveredPaise)),
    row("₹ recoverable (ceiling)", (m) => rupees(m.recoverablePaise)),
    row("mean attempts / recovery", (m) => m.meanAttemptsPerRecovery.toFixed(2)),
    row("mean hours to recovery", (m) => m.meanHoursToRecovery.toFixed(1)),
    row("escalation rate", (m) => pct(m.escalationRate)),
    row("over-nudge rate", (m) => pct(m.overNudgeRate)),
    row("root-cause accuracy", (m) => (m.rootCauseAccuracy === null ? "— (no diagnosis)" : pct(m.rootCauseAccuracy))),
    row("undiagnosed (degraded)", (m) => (m.rootCauseAccuracy === null ? "—" : `${m.undiagnosed}/${m.cases}`)),
    ...(spend && spend.calls > 0 ? spendLines(spend, agent) : []),
    ...(steps ? stepLines(steps) : []),
    ...(gates ? gateLines(gates) : []),
    "",
    exceptionArm ? `exceptions — ${exceptionArm} arm (${exceptions.length}):` : "exceptions (no arm ran):",
    ...exceptions.slice(0, 40).map((e) => `  ${e.customerRef}  ${e.failureReason}  ${e.lane}  — ${e.groundTruthNote}`),
  ];
  return lines.join("\n");
}
