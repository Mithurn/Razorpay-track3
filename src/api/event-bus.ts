import { EventEmitter } from "node:events";

// In-process fan-out from the running pipeline to any SSE clients watching a case. Single
// process only; a multi-node deployment would put Redis pub/sub here.

export type ToolSource = "local" | "razorpay-live";

// Why a turn ended. `resolved` is terminal for the case; the rest end this turn only.
export type DoneReason = "resolved" | "rescheduled" | "awaiting_settlement";

export type CaseStreamEvent =
  // Always the first event on a new subscription: what the case is doing right now, so a client
  // can tell a live run from a case that is merely being read.
  | { type: "status"; lane: string; active: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool"; name: string }
  | { type: "tool_result"; name: string; source: ToolSource; raw: unknown; ms: number }
  | {
      type: "proposal";
      rootCause: string | null;
      action: string;
      degraded: boolean;
      confidence: number;
      toolCalls: number;
      reasoning: string;
    }
  | { type: "audit"; eventType: string; payload: Record<string, unknown>; at: string }
  | { type: "done"; lane: string; reason: DoneReason };

// The room-wide feed: every durable event, across every case, in the shape the per-case stream
// already uses for `audit` plus which case it belongs to. Deliberately narrower than
// CaseStreamEvent — no reasoning deltas or tool pings here, only what was actually recorded, so
// the room view is the audit trail at a glance, not a firehose of one case's live investigation.
export type RoomStreamEvent = {
  type: "audit";
  caseId: string;
  eventType: string;
  payload: Record<string, unknown>;
  at: string;
};

export class CaseEventBus {
  private readonly emitter = new EventEmitter();
  private readonly room = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
    this.room.setMaxListeners(0);
  }

  publish(caseId: string, event: CaseStreamEvent): void {
    this.emitter.emit(caseId, event);
  }

  subscribe(caseId: string, listener: (event: CaseStreamEvent) => void): () => void {
    this.emitter.on(caseId, listener);
    return () => this.emitter.off(caseId, listener);
  }

  publishRoom(event: RoomStreamEvent): void {
    this.room.emit("room", event);
  }

  subscribeRoom(listener: (event: RoomStreamEvent) => void): () => void {
    this.room.on("room", listener);
    return () => this.room.off("room", listener);
  }
}
