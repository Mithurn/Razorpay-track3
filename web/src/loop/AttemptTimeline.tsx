import type { Attempt } from "../types.js";

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

const STATUS_CLASS: Record<string, string> = {
  RECOVERED: "tl__status--clear",
  FAILED: "tl__status--deny",
  PENDING: "tl__status--wait",
  AWAITING_RECONCILIATION: "tl__status--wait",
  SKIPPED: "tl__status--muted",
};

function refLabel(ref: string): string {
  if (ref.startsWith("plink_")) return "link";
  if (ref.startsWith("order_")) return "order";
  return "ref";
}

export function AttemptTimeline({ attempts }: { attempts: Attempt[] }) {
  if (attempts.length === 0) return null;
  const rows = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo);

  return (
    <div className="tl">
      <div className="tl__head">attempts · exactly-once, one idempotency key each</div>
      {rows.map((a) => (
        <div className="tl__row" key={a.id}>
          <span className="tl__no">#{a.attemptNo}</span>
          <span className="tl__body">
            <span className="tl__line1">
              <span className="tl__action">{a.action}</span>
              <span className={"tl__status " + (STATUS_CLASS[a.status] ?? "tl__status--muted")}>{a.status}</span>
              {a.attemptNo > 1 && <span className="tl__badge">re-plan {a.attemptNo - 1}</span>}
              {a.recoveredPaise > 0 && <span className="tl__captured">{rupees(a.recoveredPaise)} captured</span>}
            </span>
            <span className="tl__refs">
              <span className="tl__ref">
                <span className="tl__reflabel">idem</span>
                {a.idempotencyKey}
              </span>
              {a.razorpayRef && (
                <span className="tl__ref">
                  <span className="tl__reflabel">{refLabel(a.razorpayRef)}</span>
                  {a.razorpayRef}
                </span>
              )}
              {a.settledPaymentId && (
                <span className="tl__ref">
                  <span className="tl__reflabel">payment</span>
                  {a.settledPaymentId}
                </span>
              )}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
