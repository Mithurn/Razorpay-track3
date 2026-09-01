// TODO(day2): define these locally — the eval corpus types. See context/PROJECT.md.
type ScenarioClass = string; type Label = "benign" | "malicious"; type EvalCase = { scenarioClass: ScenarioClass; label: Label };

export type Prediction = "allow" | "block";

// How the investigation actually ended. A degraded investigation still produces a HOLD, which
// scores as a detection on a malicious case — so recall is only meaningful read alongside this.
export type TerminalOutcome =
  | "not_triggered"
  | "deterministic_deny"
  | `concluded:${"cleared" | "escalate" | "violation"}`
  | `degraded:${"timeout" | "error" | "budget_exhausted"}`
  | "no_terminal_event";

export type CaseResult = {
  case: EvalCase;
  arm: "rules_only" | "rules_plus_investigator";
  prediction: Prediction;
  investigationDepth: number | null;
  latencyMs: number;
  terminalOutcome?: TerminalOutcome;
  narrative?: { text: string; evidenceRefs: number[]; stepCount: number };
};

export function terminalOutcomeTally(results: CaseResult[]): { outcome: TerminalOutcome; n: number }[] {
  const counts = new Map<TerminalOutcome, number>();
  for (const r of results) {
    if (!r.terminalOutcome) continue;
    counts.set(r.terminalOutcome, (counts.get(r.terminalOutcome) ?? 0) + 1);
  }
  return [...counts.entries()].map(([outcome, n]) => ({ outcome, n })).sort((a, b) => b.n - a.n);
}

// Detections that rest on a real verdict rather than on a degraded investigation's fallback HOLD.
export function detectionsFromRealVerdicts(results: CaseResult[]): { tp: number; tpFromDegrade: number } {
  const detected = results.filter((r) => r.case.label === "malicious" && r.prediction === "block");
  const fromDegrade = detected.filter((r) => r.terminalOutcome?.startsWith("degraded")).length;
  return { tp: detected.length, tpFromDegrade: fromDegrade };
}

export type ClassMetrics = {
  scenarioClass: ScenarioClass | "all";
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
};

function labelToTruth(label: Label): Prediction {
  return label === "malicious" ? "block" : "allow";
}

function safeDiv(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

export function scoreArm(results: CaseResult[]): { overall: ClassMetrics; perClass: ClassMetrics[] } {
  const classes = [...new Set(results.map((r) => r.case.scenarioClass))];
  const perClass = classes.map((cls) => classMetrics(cls, results.filter((r) => r.case.scenarioClass === cls)));
  return { overall: classMetrics("all", results), perClass };
}

function classMetrics(scenarioClass: ScenarioClass | "all", results: CaseResult[]): ClassMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const r of results) {
    const truth = labelToTruth(r.case.label);
    if (truth === "block" && r.prediction === "block") tp += 1;
    else if (truth === "allow" && r.prediction === "block") fp += 1;
    else if (truth === "allow" && r.prediction === "allow") tn += 1;
    else fn += 1;
  }
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  return {
    scenarioClass,
    n: results.length,
    tp,
    fp,
    tn,
    fn,
    precision,
    recall,
    f1: safeDiv(2 * precision * recall, precision + recall),
  };
}

// A false positive on a benign case is a lost sale. Weight it against a nominal transaction value.
export function falsePositiveCost(results: CaseResult[], nominalSaleValuePaise = 3_000_000): { falsePositives: number; costPaise: number } {
  const fp = results.filter((r) => r.case.label === "benign" && r.prediction === "block").length;
  return { falsePositives: fp, costPaise: fp * nominalSaleValuePaise };
}

export function holdsPer1000(results: CaseResult[]): number {
  const blocked = results.filter((r) => r.prediction === "block").length;
  return safeDiv(blocked, results.length) * 1000;
}

export function meanInvestigationDepth(results: CaseResult[]): number | null {
  const depths = results.map((r) => r.investigationDepth).filter((d): d is number => d !== null);
  return depths.length === 0 ? null : depths.reduce((a, b) => a + b, 0) / depths.length;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// Only investigations that actually ran a loop — a case the deterministic layer denied or the
// trigger never fired has depth 0 but isn't an investigation, and would drag the stats down.
export function investigationDepthStats(
  results: CaseResult[],
): { mean: number; median: number; max: number; count: number } | null {
  const depths = results
    .filter((r) => r.arm === "rules_plus_investigator" && r.terminalOutcome !== undefined)
    .filter((r) => r.terminalOutcome !== "not_triggered" && r.terminalOutcome !== "deterministic_deny")
    .map((r) => r.investigationDepth)
    .filter((d): d is number => d !== null);
  if (depths.length === 0) return null;
  return {
    mean: depths.reduce((a, b) => a + b, 0) / depths.length,
    median: median(depths)!,
    max: Math.max(...depths),
    count: depths.length,
  };
}

export function latencyStats(results: CaseResult[]): { meanMs: number; medianMs: number; maxMs: number } | null {
  const investigated = results.filter(
    (r) =>
      r.arm === "rules_plus_investigator" &&
      r.terminalOutcome !== undefined &&
      r.terminalOutcome !== "not_triggered" &&
      r.terminalOutcome !== "deterministic_deny",
  );
  const ms = investigated.map((r) => r.latencyMs);
  if (ms.length === 0) return null;
  return { meanMs: ms.reduce((a, b) => a + b, 0) / ms.length, medianMs: median(ms)!, maxMs: Math.max(...ms) };
}

export function confusionCounts(results: CaseResult[]): { fp: CaseResult[]; fn: CaseResult[] } {
  const fp = results.filter((r) => r.case.label === "benign" && r.prediction === "block");
  const fn = results.filter((r) => r.case.label === "malicious" && r.prediction === "allow");
  return { fp, fn };
}
