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

export function scoreArm(arm: string, records: CaseRecord[]): ArmMetrics {
  const recovered = records.filter((r) => r.kase.lane === "RECOVERED");
  const escalated = records.filter((r) => r.kase.lane === "ESCALATED");
  const contacted = records.filter((r) => r.attempts.some((a) => a.action === "CUSTOMER_NUDGE"));

  const attemptsToRecovery = recovered.map((r) => r.attempts.filter(moneyMoves).length);
  const hoursToRecovery = recovered
    .map((r) => r.simHoursToResolution)
    .filter((h): h is number => h !== null);

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

export function formatReport(agent: ArmMetrics, fixed: ArmMetrics, exceptions: ExceptionRow[]): string {
  const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN")}`;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    "Recovery Room — two-arm evaluation",
    "",
    `                          ${"agent".padStart(12)}${"fixed".padStart(12)}`,
    `cases                     ${String(agent.cases).padStart(12)}${String(fixed.cases).padStart(12)}`,
    `recovered                 ${String(agent.recovered).padStart(12)}${String(fixed.recovered).padStart(12)}`,
    `recovery rate             ${pct(agent.recoveryRate).padStart(12)}${pct(fixed.recoveryRate).padStart(12)}`,
    `₹ recovered (bench)        ${rupees(agent.recoveredPaise).padStart(12)}${rupees(fixed.recoveredPaise).padStart(12)}`,
    `mean attempts / recovery  ${agent.meanAttemptsPerRecovery.toFixed(2).padStart(12)}${fixed.meanAttemptsPerRecovery.toFixed(2).padStart(12)}`,
    `mean hours to recovery    ${agent.meanHoursToRecovery.toFixed(1).padStart(12)}${fixed.meanHoursToRecovery.toFixed(1).padStart(12)}`,
    `escalation rate           ${pct(agent.escalationRate).padStart(12)}${pct(fixed.escalationRate).padStart(12)}`,
    `over-nudge rate           ${pct(agent.overNudgeRate).padStart(12)}${pct(fixed.overNudgeRate).padStart(12)}`,
    "",
    `exceptions (${exceptions.length}):`,
    ...exceptions.slice(0, 40).map((e) => `  ${e.customerRef}  ${e.failureReason}  ${e.lane}  — ${e.groundTruthNote}`),
  ];
  return lines.join("\n");
}
