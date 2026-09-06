import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { RedisStopStore } from "../src/worker/redis-stop-store.js";

const redisUrl = process.env.REDIS_URL;

describe.runIf(redisUrl)("RedisStopStore", () => {
  let connection: Redis;
  let store: RedisStopStore;
  const caseId = () => `case-${randomUUID()}`;

  beforeAll(() => {
    connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    store = new RedisStopStore(connection);
  });

  afterEach(async () => {
    await connection.flushdb();
  });

  afterAll(async () => {
    await connection.quit();
  });

  it("has nothing stopped by default", async () => {
    expect(await store.check(caseId())).toBeNull();
    expect(await store.isBraked()).toBe(false);
  });

  it("stops one case without affecting another", async () => {
    const a = caseId();
    const b = caseId();
    await store.stopCase(a, { reason: "user_requested" });
    expect(await store.check(a)).toEqual({ reason: "user_requested" });
    expect(await store.check(b)).toBeNull();
  });

  it("the global stop applies to every case and flips isBraked", async () => {
    const a = caseId();
    await store.stopAll({ reason: "user_requested", note: "emergency" });
    expect(await store.check(a)).toEqual({ reason: "user_requested", note: "emergency" });
    expect(await store.isBraked()).toBe(true);
  });

  it("resumeAll lifts the global stop but leaves a per-case stop in place", async () => {
    const a = caseId();
    const b = caseId();
    await store.stopCase(a, { reason: "user_requested" });
    await store.stopAll({ reason: "user_requested" });
    await store.resumeAll();
    expect(await store.check(a)).toEqual({ reason: "user_requested" });
    expect(await store.check(b)).toBeNull();
    expect(await store.isBraked()).toBe(false);
  });

  it("is visible across two independent clients sharing the same Redis instance", async () => {
    const a = caseId();
    const otherConnection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const otherStore = new RedisStopStore(otherConnection);
    try {
      await store.stopCase(a, { reason: "user_requested" });
      expect(await otherStore.check(a)).toEqual({ reason: "user_requested" });
    } finally {
      await otherConnection.quit();
    }
  });
});
