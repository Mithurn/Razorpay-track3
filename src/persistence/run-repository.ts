import type { Db } from "./pool.js";

export type RecoveryRun = {
  id: string;
  label: string | null;
  arm: "fixed" | "agent" | "rules";
  config: Record<string, unknown>;
  summary: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
};

export class RunRepository {
  constructor(private readonly db: Db) {}

  async create(id: string, arm: "fixed" | "agent" | "rules", label: string, config: Record<string, unknown>): Promise<void> {
    await this.db.query("INSERT INTO recovery_runs (id, label, arm, config) VALUES ($1, $2, $3, $4)", [
      id,
      label,
      arm,
      config,
    ]);
  }

  async finish(id: string, summary: Record<string, unknown>): Promise<void> {
    await this.db.query("UPDATE recovery_runs SET summary = $2, finished_at = now() WHERE id = $1", [id, summary]);
  }

  async latestByArm(): Promise<Record<string, RecoveryRun>> {
    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (arm) * FROM recovery_runs WHERE summary IS NOT NULL ORDER BY arm, started_at DESC`,
    );
    const out: Record<string, RecoveryRun> = {};
    for (const r of rows) {
      out[r.arm] = {
        id: r.id,
        label: r.label,
        arm: r.arm,
        config: r.config,
        summary: r.summary,
        startedAt: (r.started_at as Date).toISOString(),
        finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
      };
    }
    return out;
  }

  async byId(id: string): Promise<RecoveryRun | null> {
    const { rows } = await this.db.query("SELECT * FROM recovery_runs WHERE id = $1", [id]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      label: r.label,
      arm: r.arm,
      config: r.config,
      summary: r.summary,
      startedAt: (r.started_at as Date).toISOString(),
      finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
    };
  }
}
