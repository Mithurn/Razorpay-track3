import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import { createBudget, guardModel } from "../src/agent/budget.js";

// A stand-in for the provider that returns exactly the usage block we want to test the reader
// against. The proxy is the only thing under test here — nothing calls a network.
function fakeModel(parts: {
  generate?: { usage?: unknown };
  stream?: unknown[];
}): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "test-model",
    doGenerate: async () => parts.generate ?? {},
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          for (const p of parts.stream ?? []) controller.enqueue(p);
          controller.close();
        },
      }),
    }),
  } as unknown as LanguageModel;
}

async function drain(stream: ReadableStream<unknown>): Promise<void> {
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* consume */
  }
}

const pricing = { usdPerMInput: 1.5, usdPerMOutput: 7.5, usdPerCallFallback: 0.0025 };

describe("model budget metering", () => {
  it("reads the nested v3/v4 usage shape off a generate call", async () => {
    const budget = createBudget(10, pricing);
    const model = guardModel(
      fakeModel({ generate: { usage: { inputTokens: { total: 2_000 }, outputTokens: { total: 500 } } } }),
      budget,
    );

    await (model as unknown as { doGenerate: () => Promise<unknown> }).doGenerate();

    expect(budget.calls).toBe(1);
    expect(budget.inputTokens).toBe(2_000);
    expect(budget.outputTokens).toBe(500);
    // 2000/1e6 * 1.5 + 500/1e6 * 7.5
    expect(budget.usdUsed).toBeCloseTo(0.00675, 8);
  });

  it("reads the flat v2 usage shape too", async () => {
    const budget = createBudget(10, pricing);
    const model = guardModel(fakeModel({ generate: { usage: { inputTokens: 1_000, outputTokens: 100 } } }), budget);

    await (model as unknown as { doGenerate: () => Promise<unknown> }).doGenerate();

    expect(budget.inputTokens).toBe(1_000);
    expect(budget.outputTokens).toBe(100);
  });

  it("meters a stream from its terminal finish part", async () => {
    const budget = createBudget(10, pricing);
    const model = guardModel(
      fakeModel({
        stream: [
          { type: "text-delta", delta: "hi" },
          { type: "finish", usage: { inputTokens: { total: 4_000 }, outputTokens: { total: 1_000 } } },
        ],
      }),
      budget,
    );

    const { stream } = await (model as unknown as { doStream: () => Promise<{ stream: ReadableStream<unknown> }> }).doStream();
    // Nothing is charged until the stream is actually consumed — usage only exists at the end.
    expect(budget.inputTokens).toBe(0);
    await drain(stream);

    expect(budget.inputTokens).toBe(4_000);
    expect(budget.outputTokens).toBe(1_000);
    expect(budget.usdUsed).toBeCloseTo(0.0135, 8);
  });

  it("charges a call that reports no usage at the fallback rate instead of zero", async () => {
    const budget = createBudget(10, pricing);
    const model = guardModel(fakeModel({ generate: {} }), budget);

    await (model as unknown as { doGenerate: () => Promise<unknown> }).doGenerate();

    expect(budget.callsWithoutUsage).toBe(1);
    expect(budget.inputTokens).toBe(0);
    // The whole point: an unmetered call still moves the bill, so the cap cannot be disarmed by a
    // provider that omits usage.
    expect(budget.usdUsed).toBe(0.0025);
  });

  it("keeps a reported zero distinct from a missing usage block", async () => {
    const budget = createBudget(10, pricing);
    const model = guardModel(
      fakeModel({ generate: { usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } } } }),
      budget,
    );

    await (model as unknown as { doGenerate: () => Promise<unknown> }).doGenerate();

    expect(budget.callsWithoutUsage).toBe(0);
    expect(budget.usdUsed).toBe(0);
  });

  it("refuses the next call once measured spend passes the cap", async () => {
    const budget = createBudget(0.01, pricing);
    const model = guardModel(
      fakeModel({ generate: { usage: { inputTokens: { total: 1_000_000 }, outputTokens: { total: 0 } } } }),
      budget,
    );
    const call = () => (model as unknown as { doGenerate: () => Promise<unknown> }).doGenerate();

    // First call is admitted — spend is only known once it returns.
    await call();
    expect(budget.usdUsed).toBeCloseTo(1.5, 8);

    await expect(call()).rejects.toThrow(/model budget cap hit/);
    // The refused call never reached the provider, so it is not counted against the session.
    expect(budget.calls).toBe(1);
  });

  it("passes through unrelated model properties untouched", () => {
    const budget = createBudget(10, pricing);
    const model = guardModel(fakeModel({}), budget);
    expect((model as unknown as { modelId: string }).modelId).toBe("test-model");
    expect((model as unknown as { specificationVersion: string }).specificationVersion).toBe("v4");
  });
});
