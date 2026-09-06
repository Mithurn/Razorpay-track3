#!/usr/bin/env tsx
/**
 * verify-audit — confirms the append-only guarantee on recovery_events.
 *
 * Connects as whatever DATABASE_URL resolves to (recovery_app in production),
 * runs three checks, and exits 0 only if all pass.
 *
 *   npm run verify-audit
 */
import { createPool } from "../src/persistence/pool.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

// 1. Identity — confirm we're not accidentally running as a superuser.
const { rows: who } = await db.query<{ current_user: string; current_role: string }>(
  "SELECT current_user, pg_has_role(current_user, 'recovery_admin', 'MEMBER') AS is_admin",
);
const { current_user: role, is_admin } = who[0] as unknown as { current_user: string; is_admin: boolean };
checks.push({
  name: "Connected as recovery_app (not admin)",
  pass: !is_admin,
  detail: `current_user = ${role}${is_admin ? " — has recovery_admin membership, UPDATE/DELETE may succeed" : ""}`,
});

// 2. UPDATE is refused.
let updateRefused = false;
let updateErr = "";
try {
  await db.query("UPDATE recovery_events SET type = type WHERE id = -1");
  updateRefused = false;
  updateErr = "UPDATE succeeded — append-only NOT enforced";
} catch (err) {
  updateRefused = true;
  updateErr = err instanceof Error ? err.message : String(err);
}
checks.push({ name: "UPDATE on recovery_events is refused", pass: updateRefused, detail: updateErr });

// 3. DELETE is refused.
let deleteRefused = false;
let deleteErr = "";
try {
  await db.query("DELETE FROM recovery_events WHERE id = -1");
  deleteRefused = false;
  deleteErr = "DELETE succeeded — append-only NOT enforced";
} catch (err) {
  deleteRefused = true;
  deleteErr = err instanceof Error ? err.message : String(err);
}
checks.push({ name: "DELETE on recovery_events is refused", pass: deleteRefused, detail: deleteErr });

// 4. Row count and sequence gap check.
const { rows: stats } = await db.query<{ total: number; gaps: number; max_gap: number | null }>(
  `SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (
      WHERE id - LAG(id) OVER (ORDER BY id) > 1
    )::int AS gaps,
    MAX(id - LAG(id) OVER (ORDER BY id)) FILTER (
      WHERE id - LAG(id) OVER (ORDER BY id) > 1
    ) AS max_gap
   FROM recovery_events`,
);
const { total, gaps, max_gap } = stats[0]!;
checks.push({
  name: "No sequence gaps in recovery_events",
  pass: gaps === 0,
  detail:
    gaps === 0
      ? `${total} rows, contiguous IDs`
      : `${total} rows, ${gaps} gap(s), largest jump = ${max_gap} (deletions or out-of-order inserts)`,
});

// Print results.
let allPass = true;
for (const c of checks) {
  const icon = c.pass ? "✓" : "✗";
  console.log(`${icon} ${c.name}`);
  console.log(`  ${c.detail}`);
  if (!c.pass) allPass = false;
}

await db.end();
process.exit(allPass ? 0 : 1);
