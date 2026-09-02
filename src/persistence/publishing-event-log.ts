import type { EventLog } from "../domain/ports.js";
import type { RecoveryEvent, StoredEvent } from "../domain/events.js";

// The bus's publish signature, narrowed to the audit event. Declared here so persistence does
// not import from the api layer.
export interface AuditPublisher {
  publish(caseId: string, event: { type: "audit"; eventType: string; payload: Record<string, unknown>; at: string }): void;
}

// Wraps an EventLog so every append is also mirrored to the live stream. Reads pass straight
// through. Keeps the pipeline unaware of the bus.
export class PublishingEventLog implements EventLog {
  constructor(
    private readonly inner: EventLog,
    private readonly publisher: AuditPublisher,
  ) {}

  async append(event: RecoveryEvent): Promise<void> {
    await this.inner.append(event);
    this.publisher.publish(event.caseId, {
      type: "audit",
      eventType: event.type,
      payload: event.payload,
      at: new Date().toISOString(),
    });
  }

  forCase(caseId: string): Promise<StoredEvent[]> {
    return this.inner.forCase(caseId);
  }
}
