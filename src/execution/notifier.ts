import { randomUUID } from "node:crypto";
import type { EventLog, NotificationPort } from "../domain/ports.js";

export class LoggingNotifier implements NotificationPort {
  constructor(private readonly events: EventLog) {}

  async send(input: {
    caseId: string;
    channel: "email" | "sms";
    amountPaise: number;
    currency: string;
  }): Promise<{ messageRef: string; delivered: boolean }> {
    const messageRef = `nudge_stub_${randomUUID().slice(0, 12)}`;
    await this.events.append({
      caseId: input.caseId,
      type: "NUDGE_QUEUED",
      payload: {
        channel: input.channel,
        messageRef,
        delivered: false,
        detail: "no delivery provider is configured in this build",
        activity: "execute",
      },
    });
    return { messageRef, delivered: false };
  }
}
