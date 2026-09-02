import { describe, expect, it } from "vitest";
import { deriveLoopState, type LoopEvent } from "./useCaseLoopState.js";

const investigationStarted: LoopEvent = { type: "INVESTIGATION_STARTED", payload: { attemptNo: 1 } };
const proposed = (kind: string, extra: Record<string, unknown> = {}): LoopEvent => ({
  type: "AGENT_PROPOSED",
  payload: { action: { kind }, reasoning: "the customer pays on time; the bank is down right now", toolCalls: 4, ...extra },
});
const gate = (payload: Record<string, unknown>): LoopEvent => ({ type: "GATE_APPLIED", payload });
const outcome = (payload: Record<string, unknown>): LoopEvent => ({ type: "ATTEMPT_OUTCOME", payload });
const resolved = (lane: string): LoopEvent => ({ type: "CASE_RESOLVED", payload: { lane } });

describe("deriveLoopState", () => {
  it("is all idle for a case that has not started", () => {
    const s = deriveLoopState([]);
    expect(Object.values(s.stages).every((v) => v === "idle")).toBe(true);
    expect(s.currentEdge).toBeNull();
  });

  it("lights INVESTIGATE and the tool pills mid-run from live signals", () => {
    const s = deriveLoopState([investigationStarted], {
      open: true,
      tools: ["get_customer_payment_history", "check_bank_downtime"],
      findings: ["history → 4/4 clean"],
      reasoning: "checking history and downtime",
    });
    expect(s.stages.INCOMING).toBe("done");
    expect(s.stages.INVESTIGATE).toBe("active");
    expect(s.tools.find((t) => t.name === "get_customer_payment_history")?.status).toBe("done");
    expect(s.tools.find((t) => t.name === "check_bank_downtime")?.status).toBe("firing");
    expect(s.findingCount).toBe(1);
    expect(s.currentEdge).toBe("INCOMING-INVESTIGATE");
  });

  it("walks INVESTIGATE → PROPOSE → GATE(allow) → EXECUTE → OUTCOME on a clean recovery", () => {
    const s = deriveLoopState([
      investigationStarted,
      proposed("RETRY_SCHEDULED"),
      gate({ outcome: "allow", proposed: "RETRY_SCHEDULED", applied: "RETRY_SCHEDULED" }),
      { type: "ATTEMPT_STARTED", payload: {} },
      outcome({ status: "RECOVERED", razorpayRef: "order_abc", recoveredPaise: 149900 }),
      resolved("RECOVERED"),
    ]);
    expect(s.stages.INVESTIGATE).toBe("done");
    expect(s.stages.PROPOSE).toBe("done");
    expect(s.stages.GATE).toBe("done");
    expect(s.stages.EXECUTE).toBe("done");
    expect(s.stages.OUTCOME).toBe("done");
    expect(s.proposal).toEqual({ action: "RETRY_SCHEDULED", degraded: false });
    expect(s.attempt?.razorpayRef).toBe("order_abc");
    expect(s.finalLane).toBe("RECOVERED");
    expect(s.tools.every((t) => t.status === "done")).toBe(true);
  });

  it("marks the GATE vetoed and OUTCOME escalated when the gate clamps to ESCALATE", () => {
    const s = deriveLoopState([
      investigationStarted,
      proposed("RETRY_NOW"),
      gate({ outcome: "clamp", proposed: "RETRY_NOW", applied: "ESCALATE", reason: "risk_hold" }),
      { type: "ATTEMPT_STARTED", payload: {} },
      outcome({ status: "FAILED", razorpayRef: null, recoveredPaise: 0, detail: "escalated_to_human" }),
      resolved("ESCALATED"),
    ]);
    expect(s.gate).toMatchObject({ outcome: "clamp", proposed: "RETRY_NOW", applied: "ESCALATE" });
    expect(s.stages.GATE).toBe("vetoed");
    expect(s.stages.OUTCOME).toBe("vetoed");
    expect(s.finalLane).toBe("ESCALATED");
  });

  it("counts re-plans and animates the replan edge after a failed attempt", () => {
    const s = deriveLoopState([
      investigationStarted,
      proposed("RETRY_SCHEDULED"),
      gate({ outcome: "allow", applied: "RETRY_SCHEDULED" }),
      { type: "ATTEMPT_STARTED", payload: {} },
      outcome({ status: "FAILED", recoveredPaise: 0 }),
      investigationStarted,
    ]);
    expect(s.replanCount).toBe(1);
    expect(s.stages.OUTCOME).toBe("failed");
    expect(s.currentEdge).toBe("OUTCOME-INVESTIGATE");
  });

  it("degrades PROPOSE when the agent proposal was a degrade-to-safe fallback", () => {
    const s = deriveLoopState([investigationStarted, { type: "AGENT_DEGRADED", payload: { action: { kind: "RETRY_SCHEDULED" } } }]);
    expect(s.stages.PROPOSE).toBe("failed");
    expect(s.proposal?.degraded).toBe(true);
  });

  it("rebuilds correctly from the event tape alone on a reload (no live signals)", () => {
    const s = deriveLoopState([
      investigationStarted,
      proposed("PAYMENT_LINK", { toolCalls: 3 }),
      gate({ outcome: "allow", applied: "PAYMENT_LINK" }),
      { type: "ATTEMPT_STARTED", payload: {} },
      outcome({ status: "RECOVERED", razorpayRef: "plink_x", recoveredPaise: 99900 }),
      resolved("RECOVERED"),
    ]);
    expect(s.reasoningHead).toContain("the customer pays on time");
    expect(s.tools.filter((t) => t.status === "done")).toHaveLength(3);
    expect(s.stages.OUTCOME).toBe("done");
  });
});
