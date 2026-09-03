import type { EventLog } from "../domain/ports.js";
import type { RecoveryEvent, StoredEvent } from "../domain/events.js";

// The bus's publish signatures, narrowed to the audit event. Declared here so persistence does
// not import from the api layer.
export interface AuditPublisher {
  publish(caseId: string, event: { type: "audit"; eventType: string; payload: Record<string, unknown>; at: string }): void;
  publishRoom(event: { type: "audit"; caseId: string; eventType: string; payload: Record<string, unknown>; at: string }): void;
}

// Wraps an EventLog so every append is also mirrored to the live stream — both the case it
// belongs to and the room-wide feed. This is the single choke point every durable event passes
// through, so the room stream is exactly the canonical event log, not a second thing to keep in
// sync with it. Reads pass straight through. Keeps the pipeline unaware of the bus.
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
