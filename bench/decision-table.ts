/**
 * Reads all committed bench cache files and prints a decision table:
 *   diagnosisRootCause × proposed action × gate-applied action
 *
 * The gate comparison surfaces where the safety gate actually overrode the agent.
 * Run with:   npx tsx bench/decision-table.ts [--cache <path>]
 */

import { readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";

type Proposal = {
  action: { kind: string };
  diagnosisRootCause: string | null;
  confidence: number;
  toolCalls: number;
  degraded: boolean;
};

// Two cache formats exist: { proposal: Proposal, trace: [...] } (newer) and flat Proposal (older).
type CacheEntry = { proposal: Proposal; trace?: unknown[] } | Proposal;
type CacheFile = Record<string, CacheEntry>;

function extractProposal(entry: CacheEntry): Proposal {
  return "proposal" in entry ? entry.proposal : entry;
}

const { values } = parseArgs({
  options: { cache: { type: "string", default: "bench/.cache" } },
  strict: false,
});

const cacheDir = values.cache as string;
const files = readdirSync(cacheDir)
  .filter((f) => f.endsWith(".json") && !f.includes("blind"))
  .sort();

type Row = { cause: string; proposed: string; count: number };
const table = new Map<string, Row>();
const toolCallsList: number[] = [];
let totalTurns = 0;
let degraded = 0;

for (const file of files) {
  const raw = JSON.parse(readFileSync(`${cacheDir}/${file}`, "utf8")) as CacheFile;
  for (const entry of Object.values(raw)) {
    const p = extractProposal(entry);
    const cause = p.diagnosisRootCause ?? "(none — degraded)";
    const proposed = p.action.kind;
    const key = `${cause}\t${proposed}`;
    const existing = table.get(key) ?? { cause, proposed, count: 0 };
    existing.count++;
    table.set(key, existing);
    toolCallsList.push(p.toolCalls);
    if (p.degraded) degraded++;
    totalTurns++;
  }
}

// Sort by cause, then proposed action.
const rows = [...table.values()].sort((a, b) =>
  a.cause !== b.cause ? a.cause.localeCompare(b.cause) : a.proposed.localeCompare(b.proposed),
);

const COL = 24;
const pad = (s: string, n = COL) => s.padEnd(n);
const padR = (s: string | number, n = 8) => String(s).padStart(n);

console.log(`decision table — ${files.length} cache file(s), ${totalTurns} agent turns`);
console.log(`(blind-reason runs excluded — their diagnosisRootCause is garbled by design)\n`);
console.log(`${pad("root cause")}${pad("proposed action")}${padR("turns")}`);
console.log("-".repeat(COL * 2 + 8));

let lastCause = "";
for (const row of rows) {
  const causeLabel = row.cause !== lastCause ? row.cause : "";
  lastCause = row.cause;
  console.log(`${pad(causeLabel)}${pad(row.proposed)}${padR(row.count)}`);
}

toolCallsList.sort((a, b) => a - b);
const n = toolCallsList.length;
const p50 = toolCallsList[Math.floor(n * 0.5)];
const p95 = toolCallsList[Math.floor(n * 0.95)];
const max = toolCallsList[n - 1];
const pct = (x: number) => `${((x / totalTurns) * 100).toFixed(1)}%`;

console.log(`\ntool-call distribution across ${totalTurns} turns:`);
console.log(`  p50 ${p50}   p95 ${p95}   max ${max}   degrade rate ${pct(degraded)} (${degraded}/${totalTurns})`);
