import type { Db } from "./pool.js";

export type AuditVerifyResult = { enforced: boolean; role: string; error?: string };

// Connects as whatever role this pool uses (the app role, recovery_app) and tries a no-op
// UPDATE on recovery_events. The database checks the table privilege before touching any row,
// so this proves the append-only grant without mutating anything.
export async function verifyAppendOnly(db: Db): Promise<AuditVerifyResult> {
  const { rows } = await db.query<{ current_user: string }>("SELECT current_user");
  const role = rows[0]?.current_user ?? "unknown";
  try {
    await db.query("UPDATE recovery_events SET type = type WHERE id = -1");
    return { enforced: false, role };
  } catch (err) {
    return { enforced: true, role, error: err instanceof Error ? err.message : String(err) };
  }
}
