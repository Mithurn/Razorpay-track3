import { EventEmitter } from "node:events";

// In-process fan-out from the running pipeline to any SSE clients watching a case. Single
// process only; a multi-node deployment would put Redis pub/sub here.

export type ToolSource = "local" | "razorpay-live";

export type CaseStreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "tool"; name: string }
  | { type: "tool_result"; name: string; source: ToolSource; raw: unknown; ms: number }
  | { type: "lane"; lane: string }
  | {
      type: "proposal";
      rootCause: string | null;
      action: string;
      degraded: boolean;
      confidence: number;
      toolCalls: number;
      reasoning: string;
    }
  | { type: "attempt"; status: string; recoveredPaise: number }
  | { type: "audit"; eventType: string; payload: Record<string, unknown>; at: string }
  | { type: "done"; lane: string };

export class CaseEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(caseId: string, event: CaseStreamEvent): void {
    this.emitter.emit(caseId, event);
  }

  subscribe(caseId: string, listener: (event: CaseStreamEvent) => void): () => void {
    this.emitter.on(caseId, listener);
    return () => this.emitter.off(caseId, listener);
  }
}
