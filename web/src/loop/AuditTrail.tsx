import { useState } from "react";
import { auditSentence, relativeDelta, type AuditLimits, type AuditRow } from "./auditText.js";
import type { AuditVerify } from "../api.js";

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB");

function Row({ row, prevAt, limits }: { row: AuditRow; prevAt: string | null; limits: AuditLimits }) {
  const [open, setOpen] = useState(false);
  const s = auditSentence(row, limits);
  return (
    <div className="aud__row">
      <button className="aud__line" onClick={() => setOpen((v) => !v)}>
        <span className="aud__t">{clock(row.at)}</span>
        {prevAt && <span className="aud__delta">{relativeDelta(prevAt, row.at)}</span>}
        <span className={`aud__sentence aud__sentence--${s.tone}`}>{s.text}</span>
      </button>
      {open && <pre className="aud__json">{JSON.stringify(row.payload, null, 2)}</pre>}
    </div>
  );
}

export function AuditTrail({
  rows,
  limits,
  onVerify,
}: {
  rows: AuditRow[];
  limits: AuditLimits;
  onVerify: () => Promise<AuditVerify>;
}) {
  const [verify, setVerify] = useState<AuditVerify | "pending" | null>(null);
  const run = async () => {
    setVerify("pending");
    try {
      setVerify(await onVerify());
    } catch {
      setVerify(null);
    }
  };

  if (rows.length === 0) return null;

  return (
    <div className="aud">
      <div className="aud__head">
        <span>audit trail · append-only · the app DB role cannot UPDATE or DELETE these rows</span>
        <button className="aud__verify" onClick={run}>
          {verify === "pending" ? "checking…" : "verify"}
        </button>
      </div>
      {verify && verify !== "pending" && (
        <div className={"aud__proof" + (verify.enforced ? " aud__proof--ok" : " aud__proof--bad")}>
          {verify.enforced ? "✓" : "✗"} as {verify.role}: {verify.error ?? "UPDATE unexpectedly succeeded"}
        </div>
      )}
      {rows.map((row, i) => (
        <Row key={i} row={row} prevAt={i > 0 ? (rows[i - 1]?.at ?? null) : null} limits={limits} />
      ))}
    </div>
  );
}
