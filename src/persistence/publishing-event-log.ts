import type { EventLog } from "../domain/ports.js";
import type { RecoveryEvent, StoredEvent } from "../domain/events.js";

// Declared here, not imported from the api layer, so persistence never depends on it.
export interface AuditPublisher {
  publish(caseId: string, event: { type: "audit"; eventType: string; payload: Record<string, unknown>; at: string }): void;
  publishRoom(event: { type: "audit"; caseId: string; eventType: string; payload: Record<string, unknown>; at: string }): void;
}

export class PublishingEventLog implements EventLog {
  constructor(
    private readonly inner: EventLog,
    private readonly publisher: AuditPublisher,
  ) {}

  async append(event: RecoveryEvent): Promise<void> {
    await this.inner.append(event);
    const at = new Date().toISOString();
    this.publisher.publish(event.caseId, { type: "audit", eventType: event.type, payload: event.payload, at });
    this.publisher.publishRoom({ type: "audit", caseId: event.caseId, eventType: event.type, payload: event.payload, at });
  }

  forCase(caseId: string): Promise<StoredEvent[]> {
    return this.inner.forCase(caseId);
  }
}
