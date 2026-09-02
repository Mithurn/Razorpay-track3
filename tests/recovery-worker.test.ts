import { describe, expect, it } from "vitest";
import { makeProcessor } from "../src/worker/recovery-worker.js";
import { CaseEventBus, type CaseStreamEvent } from "../src/api/event-bus.js";
import type { RecoveryPipeline } from "../src/worker/pipeline.js";
import type { Queue } from "bullmq";
import type { RecoveryJob } from "../src/worker/queue.js";
import type { AgentEvents } from "../src/agent/recovery-agent.js";

function collect(bus: CaseEventBus, caseId: string): CaseStreamEvent[] {
  const seen: CaseStreamEvent[] = [];
  bus.subscribe(caseId, (e) => seen.push(e));
  return seen;
}

const noopQueue = { add: async () => undefined } as unknown as Queue<RecoveryJob>;

describe("recovery worker SSE forwarding", () => {
  it("carries confidence, toolCalls and reasoning on the proposal event, and the raw tool result", async () => {
    const bus = new CaseEventBus();
    const seen = collect(bus, "case-1");

    const pipeline = {
      advance: async (_caseId: string, ev: AgentEvents) => {
        ev.onToolResult?.({ name: "check_bank_downtime", source: "razorpay-live", raw: { id: "down_1" }, ms: 12 });
        ev.onConcluded?.({
          action: { kind: "RETRY_NOW" },
          diagnosisRootCause: "bank_downtime",
          confidence: 0.82,
          reasoning: "issuer BKID is in active downtime",
          toolCalls: 4,
          degraded: false,
        });
        return { kind: "resolved", lane: "RECOVERED" } as const;
      },
    } as unknown as RecoveryPipeline;

    await makeProcessor(pipeline, noopQueue, bus)({ caseId: "case-1" });

    expect(seen.find((e) => e.type === "proposal")).toMatchObject({
      type: "proposal",
      confidence: 0.82,
      toolCalls: 4,
      reasoning: "issuer BKID is in active downtime",
    });
    expect(seen.find((e) => e.type === "tool_result")).toMatchObject({
      type: "tool_result",
      name: "check_bank_downtime",
      source: "razorpay-live",
      raw: { id: "down_1" },
      ms: 12,
    });
    expect(seen.find((e) => e.type === "done")).toEqual({ type: "done", lane: "RECOVERED" });
  });

  it("emits nothing and queues nothing when the case was already claimed", async () => {
    const bus = new CaseEventBus();
    const seen = collect(bus, "case-2");
    let added = 0;
    const queue = { add: async () => void added++ } as unknown as Queue<RecoveryJob>;
    const pipeline = { advance: async () => ({ kind: "not_claimed" }) as const } as unknown as RecoveryPipeline;

    await makeProcessor(pipeline, queue, bus)({ caseId: "case-2" });

    expect(seen).toEqual([]);
    expect(added).toBe(0);
  });

  it("passes reclaim through only on a job retry", async () => {
    const bus = new CaseEventBus();
    const calls: Array<{ reclaim?: boolean }> = [];
    const pipeline = {
      advance: async (_c: string, _e: AgentEvents, opts: { reclaim?: boolean }) => {
        calls.push(opts);
        return { kind: "resolved", lane: "ESCALATED" } as const;
      },
    } as unknown as RecoveryPipeline;
    const proc = makeProcessor(pipeline, noopQueue, bus);

    await proc({ caseId: "c" });
    await proc({ caseId: "c" }, { attemptsMade: 2 });

    expect(calls).toEqual([{ reclaim: false }, { reclaim: true }]);
  });
});
