import { randomUUID } from "node:crypto";
import type { EventLog, NotificationPort } from "../domain/ports.js";

// The only stub in the build, and it is deliberate. Razorpay's own recovery agents send nudges
// over WhatsApp or email through a connector; wiring a real provider is an integration, not a
// recovery decision, so it is out of scope here. What matters is that the seam exists and that
// `delivered: false` travels with the result — nothing downstream may report a nudge as sent.

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
