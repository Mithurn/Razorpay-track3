// One source of truth for the synthetic-id marker, so a rename can't corrupt the money split.
const SIMULATED_PAYMENT_ID_PREFIXES = ["sim_", "pay_sim_"] as const;
const SIMULATED_RAZORPAY_REF_MARKER = "_bench_";

export function isSimulatedPaymentId(id: string): boolean {
  return SIMULATED_PAYMENT_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function isSimulatedRazorpayRef(ref: string): boolean {
  return ref.includes(SIMULATED_RAZORPAY_REF_MARKER);
}

// SQL LIKE patterns equivalent to isSimulatedPaymentId, with `_` escaped.
export function simulatedPaymentIdLikePatterns(): readonly string[] {
  return SIMULATED_PAYMENT_ID_PREFIXES.map((prefix) => `${prefix.replace(/_/g, "\\_")}%`);
}
