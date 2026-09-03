import { useState } from "react";
import type { Attempt } from "../types.js";
import { ChevronRight, ChevronDown } from "../ui/icons.js";

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

const STATUS_CLASS: Record<string, string> = {
  RECOVERED: "tl__status--clear",
  FAILED: "tl__status--deny",
  PENDING: "tl__status--wait",
  AWAITING_RECONCILIATION: "tl__status--wait",
  SKIPPED: "tl__status--muted",
};

const STATUS_LABEL: Record<string, string> = {
  RECOVERED: "recovered",
  FAILED: "failed",
  PENDING: "pending",
  AWAITING_RECONCILIATION: "awaiting settlement",
  SKIPPED: "skipped",
};

const ACTION_LABEL: Record<string, string> = {
  RETRY_NOW: "retried the charge",
  RETRY_SCHEDULED: "scheduled a retry",
  PAYMENT_LINK: "sent a payment link",
  ESCALATE: "escalated to a human",
  WRITE_OFF: "wrote the payment off",
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
      <div className="tl__head">
        Attempts — each one runs exactly once, tagged with a unique idempotency key so a retry can
        never double-charge
      </div>
      {rows.map((a) => (
        <AttemptRow key={a.id} attempt={a} />
      ))}
    </div>
  );
}

function AttemptRow({ attempt: a }: { attempt: Attempt }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="tl__row">
      <button className="tl__line" onClick={() => setOpen((v) => !v)}>
        <span className="tl__no">#{a.attemptNo}</span>
        <span className="tl__action">{ACTION_LABEL[a.action] ?? a.action.replace(/_/g, " ").toLowerCase()}</span>
        <span className={"tl__status " + (STATUS_CLASS[a.status] ?? "tl__status--muted")}>
          {STATUS_LABEL[a.status] ?? a.status}
        </span>
        {a.attemptNo > 1 && <span className="tl__badge">re-plan {a.attemptNo - 1}</span>}
        {a.recoveredPaise > 0 && <span className="tl__captured">{rupees(a.recoveredPaise)} captured</span>}
        <Chevron size={13} className="tl__chevron" />
      </button>
      {open && (
        <dl className="tl__ids">
          <div>
            <dt>idempotency key</dt>
            <dd>{a.idempotencyKey}</dd>
          </div>
          {a.razorpayRef && (
            <div>
              <dt>razorpay {refLabel(a.razorpayRef)}</dt>
              <dd>{a.razorpayRef}</dd>
            </div>
          )}
          {a.settledPaymentId && (
            <div>
              <dt>settled payment</dt>
              <dd>{a.settledPaymentId}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
