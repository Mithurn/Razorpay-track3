import { describe, expect, it } from "vitest";
import { StopRegistry } from "../src/worker/stop-registry.js";

describe("StopRegistry", () => {
  it("has nothing stopped by default", () => {
    expect(new StopRegistry().check("case-1")).toBeNull();
  });

  it("stops one case without affecting another", () => {
    const reg = new StopRegistry();
    reg.stopCase("case-1", { reason: "user_requested" });
    expect(reg.check("case-1")).toEqual({ reason: "user_requested" });
    expect(reg.check("case-2")).toBeNull();
  });

  it("the global stop applies to every case, including ones with no stop of their own", () => {
    const reg = new StopRegistry();
    reg.stopAll({ reason: "user_requested", note: "emergency" });
    expect(reg.check("case-1")).toEqual({ reason: "user_requested", note: "emergency" });
    expect(reg.check("case-2")).toEqual({ reason: "user_requested", note: "emergency" });
  });

  it("global takes precedence over a case's own stop request", () => {
    const reg = new StopRegistry();
    reg.stopCase("case-1", { reason: "user_requested", note: "just this one" });
    reg.stopAll({ reason: "user_requested", note: "everything" });
    expect(reg.check("case-1")).toEqual({ reason: "user_requested", note: "everything" });
  });

  it("resumeAll lifts the global stop but leaves a per-case stop in place", () => {
    const reg = new StopRegistry();
    reg.stopCase("case-1", { reason: "user_requested" });
    reg.stopAll({ reason: "user_requested" });
    reg.resumeAll();
    expect(reg.check("case-1")).toEqual({ reason: "user_requested" });
    expect(reg.check("case-2")).toBeNull();
  });
});
