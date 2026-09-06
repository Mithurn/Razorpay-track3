#!/usr/bin/env tsx
/**
 * explain — print the full ordered audit tape for a single case.
 *
 *   npm run explain -- <caseId>
 *   npm run explain -- --case <caseId>
 *
 * Outputs every stored event in chronological order including types that
 * the UI suppresses (HUMAN_DIRECTIVE, AGENT_SKIPPED_HUMAN_DIRECTED,
 * ATTEMPT_REPERFORMED, NUDGE_QUEUED, AUDIT_GAP).
 */
import { createPool } from "../src/persistence/pool.js";
import { loadConfig } from "../src/config.js";

const args = process.argv.slice(2);
const caseId =
  args.find((a) => !a.startsWith("--")) ??
  (args.indexOf("--case") !== -1 ? args[args.indexOf("--case") + 1] : undefined);

if (!caseId) {
  console.error("Usage: npm run explain -- <caseId>");
  process.exit(1);
}

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

// Verify case exists.
const { rows: caseRows } = await db.query<{
  id: string;
  customer_ref: string;
  amount_paise: number;
  lane: string;
  failure_reason: string;
}>(
  `SELECT id, customer_ref, amount_paise, lane, failure_reason
   FROM recovery_cases WHERE id = $1`,
  [caseId],
);

if (caseRows.length === 0) {
  console.error(`Case not found: ${caseId}`);
  await db.end();
  process.exit(1);
}

const kase = caseRows[0]!;
const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;

console.log(`\nCase ${kase.id}`);
console.log(`  Customer : ${kase.customer_ref}`);
console.log(`  Amount   : ${rupees(kase.amount_paise)}`);
console.log(`  Reason   : ${kase.failure_reason}`);
console.log(`  Lane     : ${kase.lane}`);
console.log();

// Fetch all events in order.
const { rows: events } = await db.query<{
  id: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}>(
  `SELECT id, type, payload, created_at
   FROM recovery_events WHERE case_id = $1 ORDER BY id ASC`,
  [caseId],
);

if (events.length === 0) {
  console.log("No events recorded.");
} else {
  for (const ev of events) {
    const ts = new Date(ev.created_at).toISOString().replace("T", " ").slice(0, 19);
    console.log(`[${ev.id}] ${ts}  ${ev.type}`);

    // Print key fields from the payload concisely.
    const p = ev.payload;
    const lines: string[] = [];

    if (p.rootCause) lines.push(`root_cause=${p.rootCause}`);
    if (p.confidence !== undefined) lines.push(`confidence=${p.confidence}`);
    if (p.action && typeof p.action === "object") {
      const a = p.action as Record<string, unknown>;
      lines.push(`action=${a.kind}`);
    }
    if (p.toolCalls !== undefined) lines.push(`tool_calls=${p.toolCalls}`);
    if (p.degraded !== undefined) lines.push(`degraded=${p.degraded}`);
    if (p.outcome) lines.push(`outcome=${p.outcome}`);
    if (p.rule) lines.push(`rule=${p.rule}`);
    if (p.detail && typeof p.detail === "string") lines.push(`detail="${p.detail}"`);
    if (p.status) lines.push(`status=${p.status}`);
    if (p.recoveredPaise !== undefined) lines.push(`recovered=${rupees(Number(p.recoveredPaise))}`);
    if (p.approver) lines.push(`approver=${p.approver}`);
    if (p.decision) lines.push(`decision=${p.decision}`);
    if (p.channel) lines.push(`channel=${p.channel}`);
    if (p.messageRef) lines.push(`ref=${p.messageRef}`);
    if (p.model) lines.push(`model=${p.model}`);

    if (lines.length > 0) console.log(`       ${lines.join("  ")}`);

    if (ev.type === "AUDIT_GAP") {
      console.log("       ⚠ system admitted it lost an event here");
    }
  }
}

console.log(`\n${events.length} event(s) total.`);

await db.end();
