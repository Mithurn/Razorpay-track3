import { describe, expect, it } from "vitest";
import { isRiskHold, RISK_CHECK_FAILURE_REASON, type RecoveryCase } from "../src/domain/case.js";

function caseWith(failureReason: string): RecoveryCase {
  return {
    id: "3f1d9a2e-0000-4000-8000-000000000001",
    runId: null,
    merchantRef: "merch_1",
    customerRef: "cust_1",
    originalPaymentId: null,
    amountPaise: 149900,
    currency: "INR",
    failureCode: "BAD_REQUEST_ERROR",
    failureReason,
    failedAt: new Date().toISOString(),
    method: "card",
    instrument: null,
    customerHistory: [],
    lane: "INCOMING",
    recoveredPaise: 0,
  };
}

describe("isRiskHold", () => {
  it("flags the risk-check failure reason", () => {
    expect(isRiskHold(caseWith(RISK_CHECK_FAILURE_REASON))).toBe(true);
  });

  it("does not flag ordinary declines", () => {
    for (const reason of ["card_declined", "payment_failed", "insufficient_funds"]) {
      expect(isRiskHold(caseWith(reason))).toBe(false);
    }
  });
});
