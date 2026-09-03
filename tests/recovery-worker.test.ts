import { describe, expect, it } from "vitest";
import { makeProcessor } from "../src/worker/recovery-worker.js";
import { CaseEventBus, type CaseStreamEvent } from "../src/api/event-bus.js";
import type { RecoveryPipeline } from "../src/worker/pipeline.js";
import type { Queue } from "bullmq";
import type { RecoveryJob } from "../src/worker/queue.js";
import type { AgentEvents } from "../src/agent/recovery-agent.js";
import type { EventLog } from "../src/domain/ports.js";
import type { RecoveryEvent } from "../src/domain/events.js";

function collect(bus: CaseEventBus, caseId: string): CaseStreamEvent[] {
  const seen: CaseStreamEvent[] = [];
  bus.subscribe(caseId, (e) => seen.push(e));
  return seen;
}

function fakeEventLog(): EventLog & { appended: RecoveryEvent[] } {
  const appended: RecoveryEvent[] = [];
  return {
    appended,
    append: async (event) => {
      appended.push(event);
    },
    forCase: async () => [],
  };
}

const noopQueue = { add: async () => undefined } as unknown as Queue<RecoveryJob>;

describe("recovery worker SSE forwarding", () => {
  it("carries confidence, toolCalls and reasoning on the proposal event, and the raw tool result", async () => {
    const bus = new CaseEventBus();
    const events = fakeEventLog();
    const seen = collect(bus, "case-1");

    const pipeline = {
      advance: async (_caseId: string, ev: AgentEvents) => {
        ev.onToolCall?.({ name: "check_bank_downtime", callId: "call_1", args: {} });
        ev.onToolResult?.({
          name: "check_bank_downtime",
          callId: "call_1",
          source: "razorpay-live",
          raw: { id: "down_1" },
          ms: 12,
        });
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

    await makeProcessor(pipeline, noopQueue, bus, events)({ caseId: "case-1" });

    expect(seen.find((e) => e.type === "proposal")).toMatchObject({
      type: "proposal",
      confidence: 0.82,
      toolCalls: 4,
      reasoning: "issuer BKID is in active downtime",
    });
    // The ephemeral bus signal, for a responsive live UI.
    expect(seen.find((e) => e.type === "tool_result")).toMatchObject({
      type: "tool_result",
      name: "check_bank_downtime",
      source: "razorpay-live",
      raw: { id: "down_1" },
      ms: 12,
    });
    expect(seen.find((e) => e.type === "done")).toEqual({
      type: "done",
      lane: "RECOVERED",
      reason: "resolved",
    });

    // The durable trail, keyed so a call and its result can be joined later.
    expect(events.appended).toContainEqual({
      caseId: "case-1",
      type: "TOOL_CALLED",
      payload: { name: "check_bank_downtime", callId: "call_1", args: {}, activity: "investigate" },
    });
    expect(events.appended).toContainEqual({
      caseId: "case-1",
      type: "TOOL_RESULT",
      payload: {
        name: "check_bank_downtime",
        callId: "call_1",
        source: "razorpay-live",
        raw: { id: "down_1" },
        ms: 12,
        activity: "investigate",
      },
    });
  });

  // A turn that parks the case still ends the turn. Without this the watching client keeps
  // showing an investigation that is no longer running.
  it("ends the turn on a reschedule, and still queues the next one", async () => {
    const bus = new CaseEventBus();
    const seen = collect(bus, "case-3");
    let added = 0;
    const queue = { add: async () => void added++ } as unknown as Queue<RecoveryJob>;
    const pipeline = {
      advance: async () => ({ kind: "reschedule", delayMs: 1000, reason: "attempt failed" }) as const,
    } as unknown as RecoveryPipeline;

    await makeProcessor(pipeline, queue, bus, fakeEventLog())({ caseId: "case-3" });

    expect(seen).toEqual([{ type: "done", lane: "RETRY_SCHEDULED", reason: "rescheduled" }]);
    expect(added).toBe(1);
  });

  it("ends the turn while an attempt is awaiting settlement", async () => {
    const bus = new CaseEventBus();
    const seen = collect(bus, "case-4");
    const pipeline = {
      advance: async () => ({ kind: "awaiting_settlement", delayMs: 1000 }) as const,
    } as unknown as RecoveryPipeline;

    await makeProcessor(pipeline, noopQueue, bus, fakeEventLog())({ caseId: "case-4" });

    expect(seen).toEqual([{ type: "done", lane: "ATTEMPTING", reason: "awaiting_settlement" }]);
  });

  it("emits nothing and queues nothing when the case was already claimed", async () => {
    const bus = new CaseEventBus();
    const seen = collect(bus, "case-2");
    let added = 0;
    const queue = { add: async () => void added++ } as unknown as Queue<RecoveryJob>;
    const pipeline = { advance: async () => ({ kind: "not_claimed" }) as const } as unknown as RecoveryPipeline;

    await makeProcessor(pipeline, queue, bus, fakeEventLog())({ caseId: "case-2" });

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
    const proc = makeProcessor(pipeline, noopQueue, bus, fakeEventLog());

    await proc({ caseId: "c" });
    await proc({ caseId: "c" }, { attemptsMade: 2 });

    expect(calls).toEqual([{ reclaim: false }, { reclaim: true }]);
  });
});
