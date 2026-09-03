import type { ToolResultEvent } from "../types.js";

// Two short lines per investigation tool: what it is doing, and what it found. Both are for the
// live commentary stream — terminal-log short, never a sentence that wraps.

const ACT: Record<string, string> = {
  get_customer_payment_history: "reading customer history…",
  check_bank_downtime: "checking Razorpay downtime feed…",
  get_similar_resolved_cases: "looking up similar resolved cases…",
  get_this_case_prior_attempts: "checking this case's prior attempts…",
  get_recovery_playbook: "checking the merchant's recovery playbook…",
};

export function actLine(name: string): string {
  return ACT[name] ?? `running ${name}…`;
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function relativeAge(iso: unknown): string {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 90) return `began ${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `began ${hr}h ago`;
  return `began ${Math.round(hr / 24)}d ago`;
}

export function resultLine(name: string, raw: unknown): string {
  const o = rec(raw);

  if (name === "get_customer_payment_history") {
    const ok = Number(o.successfulPayments ?? 0);
    const total = Number(o.totalPayments ?? 0);
    const since = o.daysSinceLastSuccess;
    const cadence = o.medianDaysBetweenPayments;
    const parts = [`${ok}/${total} clean`];
    if (typeof since === "number") parts.push(`last ${since}d ago`);
    if (typeof cadence === "number") parts.push(`pays ~${cadence}d`);
    return `→ ${parts.join(" · ")}`;
  }

  if (name === "check_bank_downtime") {
    const active = Array.isArray(o.activeDowntimes) ? o.activeDowntimes : [];
    if (!o.matched || active.length === 0) return `→ no active downtime on ${o.method ?? "this method"}`;
    const d = rec(active[0]);
    const issuer = Object.values(rec(d.instrument)).join("/") || String(o.method ?? "");
    return `→ MATCH · ${issuer} · ${d.severity ?? "?"} · ${relativeAge(d.startedAt)}`.replace(/ · $/, "");
  }

  if (name === "get_similar_resolved_cases") {
    const cases = Array.isArray(o.cases) ? o.cases : [];
    if (cases.length === 0) return "→ no similar cases on record";
    const recovered = cases.filter((c) => String(rec(c).outcome).toUpperCase().includes("RECOVER"));
    const lead = rec(recovered[0] ?? cases[0]);
    return `→ ${cases.length} seen · ${recovered.length} recovered via ${lead.action ?? "?"}`;
  }

  if (name === "get_this_case_prior_attempts") {
    const attempts = Array.isArray(o.attempts) ? o.attempts : [];
    if (attempts.length === 0) return "→ no prior attempts on this payment";
    const last = rec(attempts[attempts.length - 1]);
    return `→ ${attempts.length} prior · last ${last.action ?? "?"} ${last.outcome ?? ""}`.trim();
  }

  if (name === "get_recovery_playbook") {
    const playbook = Array.isArray(o.playbook) ? o.playbook.length : 0;
    return `→ ${playbook} default move${playbook === 1 ? "" : "s"} on file`;
  }

  return `→ ${name} done`;
}

// The card fields for the node-click INVESTIGATE detail: the raw record, flattened to labelled
// rows. For the downtime call this is the live Razorpay record.
export function resultFields(r: ToolResultEvent): { label: string; value: string }[] {
  const o = rec(r.raw);
  if (r.name === "check_bank_downtime") {
    const active = Array.isArray(o.activeDowntimes) ? o.activeDowntimes : [];
    const d = rec(active[0]);
    if (!d.severity && !d.id) return [{ label: "result", value: "no active downtime" }];
    return [
      { label: "id", value: String(d.id ?? "—") },
      { label: "method", value: String(d.method ?? o.method ?? "—") },
      { label: "issuer", value: String(Object.values(rec(d.instrument)).join("/") || "—") },
      { label: "severity", value: String(d.severity ?? "—") },
      { label: "began", value: String(d.startedAt ?? "—") },
    ];
  }
  return Object.entries(o).map(([label, value]) => ({
    label,
    value: typeof value === "object" ? JSON.stringify(value) : String(value),
  }));
}
