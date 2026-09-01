import { describe, expect, it } from "vitest";
import {
  TRANSITIONS,
  VALID_FROM,
  canTransition,
  isTerminal,
  type ExecutionState,
} from "../src/domain/execution.js";

describe("execution state machine", () => {
  it("reverses TRANSITIONS into VALID_FROM without losing edges", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS) as [
      ExecutionState,
      readonly ExecutionState[],
    ][]) {
      for (const to of targets) {
        expect(VALID_FROM[to]).toContain(from);
      }
    }
    for (const [to, sources] of Object.entries(VALID_FROM) as [
      ExecutionState,
      readonly ExecutionState[],
    ][]) {
      for (const from of sources) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });

  it("terminal states accept no outgoing transitions", () => {
    for (const state of ["CAPTURED", "FAILED"] as ExecutionState[]) {
      expect(isTerminal(state)).toBe(true);
      expect(TRANSITIONS[state]).toHaveLength(0);
    }
    for (const targets of Object.values(VALID_FROM)) {
      for (const terminal of ["CAPTURED", "FAILED"] as ExecutionState[]) {
        expect(targets).not.toContain(terminal);
      }
    }
  });

  it("CAPTURING cannot regress to AWAITING_PAYMENT", () => {
    expect(canTransition("CAPTURING", "AWAITING_PAYMENT")).toBe(false);
  });

  it("FAILED cannot be resurrected", () => {
    expect(VALID_FROM["CAPTURED"]).not.toContain("FAILED");
    expect(TRANSITIONS["FAILED"]).toHaveLength(0);
  });
});
