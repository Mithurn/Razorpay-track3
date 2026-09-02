import { describe, expect, it } from "vitest";
import { summariseFinding } from "../src/agent/findings.js";

describe("summariseFinding", () => {
  it("reads the customer history into one line", () => {
    expect(
      summariseFinding("get_customer_payment_history", {
        successfulPayments: 4,
        totalPayments: 4,
        daysSinceLastSuccess: 30,
      }),
    ).toBe("history → 4/4 clean, last success 30d ago");
  });

  it("calls out a downtime match", () => {
    expect(
      summariseFinding("check_bank_downtime", {
        method: "card",
        matched: true,
        activeDowntimes: [{ severity: "high", instrument: { issuer: "BKID" } }],
      }),
    ).toBe("downtime → BKID high · MATCH");
  });

  it("says so when there is no downtime", () => {
    expect(
      summariseFinding("check_bank_downtime", { method: "card", matched: false, activeDowntimes: [] }),
    ).toBe("downtime → none active on card");
  });

  it("summarises what recovered similar cases", () => {
    expect(
      summariseFinding("get_similar_resolved_cases", {
        cases: [
          { action: "RETRY_SCHEDULED", outcome: "RECOVERED", hoursToResolution: 14 },
          { action: "ESCALATE", outcome: "ESCALATED", hoursToResolution: null },
        ],
      }),
    ).toBe("similar cases → 2 seen, 1 recovered via RETRY_SCHEDULED ~14h");
  });

  it("never throws on an unexpected shape", () => {
    expect(summariseFinding("get_this_case_prior_attempts", null)).toBe("prior attempts → none on this payment");
    expect(summariseFinding("mystery_tool", { a: 1 })).toBe("mystery_tool → done");
  });
});
