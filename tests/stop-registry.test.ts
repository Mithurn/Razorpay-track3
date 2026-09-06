import { describe, expect, it } from "vitest";
import { InMemoryStopStore } from "../src/worker/stop-registry.js";

describe("InMemoryStopStore", () => {
  it("has nothing stopped by default", async () => {
    expect(await new InMemoryStopStore().check("case-1")).toBeNull();
  });

  it("stops one case without affecting another", async () => {
    const store = new InMemoryStopStore();
    await store.stopCase("case-1", { reason: "user_requested" });
    expect(await store.check("case-1")).toEqual({ reason: "user_requested" });
    expect(await store.check("case-2")).toBeNull();
  });

  it("the global stop applies to every case, including ones with no stop of their own", async () => {
    const store = new InMemoryStopStore();
    await store.stopAll({ reason: "user_requested", note: "emergency" });
    expect(await store.check("case-1")).toEqual({ reason: "user_requested", note: "emergency" });
    expect(await store.check("case-2")).toEqual({ reason: "user_requested", note: "emergency" });
  });

  it("global takes precedence over a case's own stop request", async () => {
    const store = new InMemoryStopStore();
    await store.stopCase("case-1", { reason: "user_requested", note: "just this one" });
    await store.stopAll({ reason: "user_requested", note: "everything" });
    expect(await store.check("case-1")).toEqual({ reason: "user_requested", note: "everything" });
  });

  it("resumeAll lifts the global stop but leaves a per-case stop in place", async () => {
    const store = new InMemoryStopStore();
    await store.stopCase("case-1", { reason: "user_requested" });
    await store.stopAll({ reason: "user_requested" });
    await store.resumeAll();
    expect(await store.check("case-1")).toEqual({ reason: "user_requested" });
    expect(await store.check("case-2")).toBeNull();
  });

  it("isBraked reflects the global stop state", async () => {
    const store = new InMemoryStopStore();
    expect(await store.isBraked()).toBe(false);
    await store.stopAll({ reason: "user_requested" });
    expect(await store.isBraked()).toBe(true);
    await store.resumeAll();
    expect(await store.isBraked()).toBe(false);
  });
});
