import { describe, expect, it } from "vitest";
import { actLine, resultLine, resultFields } from "./toolLine.js";
import type { ToolResultEvent } from "../types.js";

describe("actLine", () => {
  it("names the tool as an in-progress action", () => {
    expect(actLine("check_bank_downtime")).toBe("checking Razorpay downtime feed…");
    expect(actLine("mystery")).toBe("running mystery…");
  });
});

describe("resultLine", () => {
  it("summarises a clean customer history", () => {
    expect(
      resultLine("get_customer_payment_history", {
        successfulPayments: 4,
        totalPayments: 4,
        daysSinceLastSuccess: 30,
        medianDaysBetweenPayments: 32,
      }),
    ).toBe("→ 4/4 clean · last 30d ago · pays ~32d");
  });

  it("calls a downtime match with the issuer and severity", () => {
    const line = resultLine("check_bank_downtime", {
      method: "card",
      matched: true,
      activeDowntimes: [
        { severity: "high", instrument: { issuer: "BKID" }, startedAt: new Date(Date.now() - 38 * 60000).toISOString() },
      ],
    });
    expect(line).toContain("→ MATCH · BKID · high · began 38 min ago");
  });

  it("says so when there is no downtime", () => {
    expect(resultLine("check_bank_downtime", { method: "card", matched: false, activeDowntimes: [] })).toBe(
      "→ no active downtime on card",
    );
  });

  it("never throws on a surprise shape", () => {
    expect(resultLine("get_this_case_prior_attempts", null)).toBe("→ no prior attempts on this payment");
  });
});

describe("resultFields", () => {
  it("flattens the live downtime record to labelled rows", () => {
    const ev: ToolResultEvent = {
      type: "tool_result",
      name: "check_bank_downtime",
      source: "razorpay-live",
      ms: 12,
      raw: {
        method: "card",
        matched: true,
        activeDowntimes: [{ id: "down_Ng7", method: "card", severity: "high", instrument: { issuer: "BKID" }, startedAt: "2026-09-02T14:02:00Z" }],
      },
    };
    const fields = resultFields(ev);
    expect(fields).toContainEqual({ label: "id", value: "down_Ng7" });
    expect(fields).toContainEqual({ label: "issuer", value: "BKID" });
    expect(fields).toContainEqual({ label: "severity", value: "high" });
  });
});
