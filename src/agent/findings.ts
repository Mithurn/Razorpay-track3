// Turns a raw investigation-tool result into the one-line finding the room shows as the agent
// works. Best-effort: an unrecognised shape yields a plain "tool ran" line, never a throw.

type Finding = string;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function summariseFinding(toolName: string, output: unknown): Finding {
  const o = asRecord(output);

  if (toolName === "get_customer_payment_history") {
    const ok = Number(o.successfulPayments ?? 0);
    const total = Number(o.totalPayments ?? 0);
    const since = o.daysSinceLastSuccess;
    const tail = typeof since === "number" ? `last success ${since}d ago` : "no prior success";
    return `history → ${ok}/${total} clean, ${tail}`;
  }

  if (toolName === "check_bank_downtime") {
    const active = Array.isArray(o.activeDowntimes) ? o.activeDowntimes : [];
    if (!o.matched || active.length === 0) return `downtime → none active on ${o.method ?? "this method"}`;
    const d = asRecord(active[0]);
    const inst = Object.values(asRecord(d.instrument)).join("/") || String(o.method ?? "");
    return `downtime → ${inst} ${d.severity ?? ""} · MATCH`.replace(/\s+/g, " ").trim();
  }

  if (toolName === "get_similar_resolved_cases") {
    const cases = Array.isArray(o.cases) ? o.cases : [];
    if (cases.length === 0) return "similar cases → none on record";
    const recovered = cases.filter((c) => String(asRecord(c).outcome).toUpperCase().includes("RECOVER"));
    const lead = asRecord(recovered[0] ?? cases[0]);
    const hrs = lead.hoursToResolution;
    const when = typeof hrs === "number" ? ` ~${Math.round(hrs)}h` : "";
    return `similar cases → ${cases.length} seen, ${recovered.length} recovered via ${lead.action ?? "?"}${when}`;
  }

  if (toolName === "get_this_case_prior_attempts") {
    const attempts = Array.isArray(o.attempts) ? o.attempts : [];
    if (attempts.length === 0) return "prior attempts → none on this payment";
    const last = asRecord(attempts[attempts.length - 1]);
    return `prior attempts → ${attempts.length}, last ${last.action ?? "?"} ${last.outcome ?? ""}`.trim();
  }

  return `${toolName} → done`;
}
