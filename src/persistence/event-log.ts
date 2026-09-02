import type { EventLog } from "../domain/ports.js";
import type { RecoveryEvent, StoredEvent } from "../domain/events.js";
import { recoveryEventType } from "../domain/events.js";
import type { Db } from "./pool.js";

// Append-only by database grant, not by convention: the app role holds SELECT and INSERT on
// recovery_events and nothing else. There is deliberately no update or delete method here.

export class PostgresEventLog implements EventLog {
  constructor(private readonly db: Db) {}

  async append(event: RecoveryEvent): Promise<void> {
    await this.db.query("INSERT INTO recovery_events (case_id, type, payload) VALUES ($1, $2, $3)", [
      event.caseId,
      recoveryEventType.parse(event.type),
      event.payload,
    ]);
  }

  async forCase(caseId: string): Promise<StoredEvent[]> {
    const { rows } = await this.db.query(
      "SELECT id, case_id, type, payload, created_at FROM recovery_events WHERE case_id = $1 ORDER BY id",
      [caseId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      caseId: r.case_id,
      type: recoveryEventType.parse(r.type),
      payload: r.payload,
      createdAt: (r.created_at as Date).toISOString(),
    }));
  }
}
