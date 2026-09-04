import type { WebhookInbox } from "../domain/ports.js";
import type { Db } from "./pool.js";

// event_id is the primary key, so a duplicate delivery collides and inserts nothing.
export class PostgresWebhookInbox implements WebhookInbox {
  constructor(private readonly db: Db) {}

  async recordIfNew(eventId: string, event: string, payload: unknown): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "INSERT INTO razorpay_webhooks (event_id, event, payload) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING",
      [eventId, event, payload],
    );
    return rowCount === 1;
  }
}
