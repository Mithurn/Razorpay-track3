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

export function formatReport(agent: ArmMetrics, fixed: ArmMetrics, exceptions: ExceptionRow[], rules?: ArmMetrics): string {
  const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN")}`;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const arms = [agent, fixed, ...(rules ? [rules] : [])];
  const col = (n: number | string) => String(n).padStart(12);
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
    "",
    `exceptions (${exceptions.length}):`,
    ...exceptions.slice(0, 40).map((e) => `  ${e.customerRef}  ${e.failureReason}  ${e.lane}  — ${e.groundTruthNote}`),
  ];
  return lines.join("\n");
}
