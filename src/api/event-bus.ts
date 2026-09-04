import { EventEmitter } from "node:events";
import type { ToolSource } from "../agent/recovery-agent.js";

export type { ToolSource };

export type DoneReason = "resolved" | "rescheduled" | "awaiting_settlement";

export type CaseStreamEvent =
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

// Deliberately narrower than CaseStreamEvent — only what was actually recorded, no live tool pings.
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
