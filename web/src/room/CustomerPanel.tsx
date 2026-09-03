import type { RecoveryCase } from "../types.js";

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const dateFmt = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

// On-demand customer context — everything already on the case, laid out for a human deciding
// whether to trust the agent's read of this customer. Not always open; toggled from the case
// header.
export function CustomerPanel({ kase }: { kase: RecoveryCase }) {
  const captured = kase.customerHistory.filter((h) => h.status === "captured");
  const failed = kase.customerHistory.filter((h) => h.status === "failed");
  const lastSuccess = captured.at(-1);

  return (
    <div className="cust-panel">
      <div className="cust-panel__grid">
        <Field label="customer" value={kase.customerRef} />
        <Field label="merchant" value={kase.merchantRef} />
        <Field label="current failure" value={`${kase.failureReason} (${kase.failureCode})`} />
        <Field label="instrument" value={kase.instrument?.issuer ?? kase.method ?? "card"} />
        <Field label="amount at risk" value={rupees(kase.amountPaise)} />
        <Field label="already recovered" value={kase.recoveredPaise > 0 ? rupees(kase.recoveredPaise) : "—"} />
        <Field label="failed at" value={dateFmt(kase.failedAt)} />
        <Field label="current state" value={kase.lane.replace(/_/g, " ").toLowerCase()} />
      </div>

      <div className="cust-panel__history">
        <span className="cust-panel__history-label">
          payment history · {captured.length} clean · {failed.length} failed
          {lastSuccess && ` · last success ${dateFmt(lastSuccess.paidAt)}`}
        </span>
        <ul className="cust-panel__history-list">
          {[...kase.customerHistory]
            .sort((a, b) => Date.parse(b.paidAt) - Date.parse(a.paidAt))
            .slice(0, 8)
            .map((h, i) => (
              <li key={i} className={`cust-panel__history-row cust-panel__history-row--${h.status}`}>
                <span>{dateFmt(h.paidAt)}</span>
                <span>{rupees(h.amountPaise)}</span>
                <span>{h.method}</span>
                <span>{h.status}</span>
              </li>
            ))}
          {kase.customerHistory.length === 0 && <li className="empty">No prior payment history on record.</li>}
        </ul>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="cust-panel__field">
      <span className="cust-panel__field-label">{label}</span>
      <span className="cust-panel__field-value">{value}</span>
    </div>
  );
}
