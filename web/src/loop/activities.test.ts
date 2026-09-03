import { describe, expect, it } from "vitest";
import { deriveActivities, activityDurationMs, type RawEvent } from "./activities.js";

const ev = (type: string, payload: Record<string, unknown>, at: string): RawEvent => ({ type, payload, at });

describe("deriveActivities", () => {
  it("groups a full recovered run into five activities with tool sub-entries", () => {
    const events: RawEvent[] = [
      ev("INVESTIGATION_STARTED", { attemptNo: 1 }, "2026-09-03T10:00:00.000Z"),
      ev("TOOL_CALLED", { name: "get_customer_payment_history", callId: "c1" }, "2026-09-03T10:00:01.000Z"),
      ev("TOOL_RESULT", { name: "get_customer_payment_history", callId: "c1", raw: { totalPayments: 4, successfulPayments: 4 } }, "2026-09-03T10:00:01.500Z"),
      ev(
        "AGENT_PROPOSED",
        { rootCause: "soft_decline", confidence: 0.9, action: { kind: "RETRY_NOW" }, reasoning: "clean history", toolCalls: 1 },
        "2026-09-03T10:00:03.000Z",
      ),
      ev("GATE_APPLIED", { outcome: "allow", proposed: "RETRY_NOW", applied: "RETRY_NOW", rule: null, detail: null }, "2026-09-03T10:00:03.100Z"),
      ev("ATTEMPT_STARTED", { attemptNo: 1, action: { kind: "RETRY_NOW" }, clamped: false }, "2026-09-03T10:00:03.200Z"),
      ev("ATTEMPT_OUTCOME", { attemptNo: 1, status: "RECOVERED", recoveredPaise: 149900, razorpayRef: "order_1" }, "2026-09-03T10:00:05.000Z"),
      ev("CASE_RESOLVED", { lane: "RECOVERED" }, "2026-09-03T10:00:05.100Z"),
    ];

    const activities = deriveActivities(events);
    expect(activities.map((a) => a.kind)).toEqual(["investigate", "propose", "gate", "execute", "outcome"]);

    const investigate = activities[0]!;
    expect(investigate.status).toBe("done");
    expect(investigate.tools).toHaveLength(1);
    expect(investigate.tools[0]).toMatchObject({ name: "get_customer_payment_history", status: "done" });
    expect(investigate.tools[0]!.summary).toContain("4/4 clean");

    const gate = activities[2]!;
    expect(gate.tone).toBe("clear");
    expect(gate.summary).toContain("passed");

    const execute = activities[3]!;
    expect(execute.status).toBe("done");
    expect(execute.tone).toBe("clear");
    expect(execute.summary).toContain("₹1,499");
    expect(activityDurationMs(execute)).toBe(1800);

    const outcome = activities[4]!;
    expect(outcome.tone).toBe("clear");
    expect(outcome.summary).toBe("recovered");
  });

  it("gives the guardrail clamp a deny tone and names the rule", () => {
    const events: RawEvent[] = [
      ev("INVESTIGATION_STARTED", { attemptNo: 1 }, "t0"),
      ev("AGENT_PROPOSED", { rootCause: "soft_decline", confidence: 0.9, action: { kind: "RETRY_NOW" }, reasoning: "x", toolCalls: 0 }, "t1"),
      ev(
        "GATE_APPLIED",
        { outcome: "clamp", proposed: "RETRY_NOW", applied: "ESCALATE", rule: "exposure_cap", detail: "amount exceeds the cap" },
        "t2",
      ),
      ev("CASE_RESOLVED", { lane: "ESCALATED" }, "t3"),
    ];
    const activities = deriveActivities(events);
    const gate = activities.find((a) => a.kind === "gate")!;
    expect(gate.tone).toBe("deny");
    expect(gate.summary).toContain("exposure_cap");
    expect(gate.detail).toContainEqual({ label: "rule", value: "exposure_cap" });
  });

  it("renders a stop as its own outcome activity, distinct from a normal resolution", () => {
    const events: RawEvent[] = [
      ev("INVESTIGATION_STARTED", { attemptNo: 1 }, "t0"),
      ev("CASE_STOPPED", { reason: "user_requested", note: "demo" }, "t1"),
    ];
    const activities = deriveActivities(events);
    const outcome = activities.find((a) => a.kind === "outcome")!;
    expect(outcome.title).toBe("Stopped");
    expect(outcome.tone).toBe("deny");
    expect(outcome.summary).toContain("user_requested");
  });

  it("starts a fresh investigate activity per re-plan attempt, not one merged block", () => {
    const events: RawEvent[] = [
      ev("INVESTIGATION_STARTED", { attemptNo: 1 }, "t0"),
      ev("AGENT_PROPOSED", { rootCause: "soft_decline", confidence: 0.5, action: { kind: "RETRY_NOW" }, reasoning: "x", toolCalls: 0 }, "t1"),
      ev("GATE_APPLIED", { outcome: "allow", proposed: "RETRY_NOW", applied: "RETRY_NOW", rule: null, detail: null }, "t2"),
      ev("ATTEMPT_STARTED", { attemptNo: 1, action: { kind: "RETRY_NOW" }, clamped: false }, "t3"),
      ev("ATTEMPT_OUTCOME", { attemptNo: 1, status: "FAILED", recoveredPaise: 0, razorpayRef: null }, "t4"),
      ev("INVESTIGATION_STARTED", { attemptNo: 2 }, "t5"),
    ];
    const activities = deriveActivities(events);
    const investigations = activities.filter((a) => a.kind === "investigate");
    expect(investigations).toHaveLength(2);
    expect(investigations[0]!.status).toBe("done");
    expect(investigations[1]!.status).toBe("active");
  });

  it("skips structural lane-change events in the narrative stream", () => {
    const events: RawEvent[] = [
      ev("CASE_LANE_CHANGED", { from: "INCOMING", to: "DIAGNOSING" }, "t0"),
      ev("INVESTIGATION_STARTED", { attemptNo: 1 }, "t1"),
    ];
    const activities = deriveActivities(events);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.kind).toBe("investigate");
  });
});
