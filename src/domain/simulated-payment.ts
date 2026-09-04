// A synthetic id never reached Razorpay. Two id spaces carry the marker: a settled_payment_id
// prefixed `sim_`/`pay_sim_` (the demo's own simulate-capture button, and the bench evaluation's
// ground-truth settlement), and a razorpayRef containing `_bench_` (an order/link the bench
// evaluation created for real but whose authorization is simulated). One source of truth, so a
// rename in one place can't silently corrupt the live-vs-simulated money split.

const SIMULATED_PAYMENT_ID_PREFIXES = ["sim_", "pay_sim_"] as const;
const SIMULATED_RAZORPAY_REF_MARKER = "_bench_";

export function isSimulatedPaymentId(id: string): boolean {
  return SIMULATED_PAYMENT_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function isSimulatedRazorpayRef(ref: string): boolean {
  return ref.includes(SIMULATED_RAZORPAY_REF_MARKER);
}

/** SQL LIKE patterns (with `_` escaped) equivalent to isSimulatedPaymentId, for use in a query. */
export function simulatedPaymentIdLikePatterns(): readonly string[] {
  return SIMULATED_PAYMENT_ID_PREFIXES.map((prefix) => `${prefix.replace(/_/g, "\\_")}%`);
}
