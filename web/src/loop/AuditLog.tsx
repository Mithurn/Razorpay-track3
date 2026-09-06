import type { StoredEvent } from "../types.js";

const DROPPED_TYPES = new Set([
  "HUMAN_DIRECTIVE",
  "AGENT_SKIPPED_HUMAN_DIRECTED",
  "ATTEMPT_REPERFORMED",
  "NUDGE_QUEUED",
  "AUDIT_GAP",
]);

function fmt(ts: string): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function EventRow({ ev }: { ev: StoredEvent }) {
  const dropped = DROPPED_TYPES.has(ev.type);
  const isGap = ev.type === "AUDIT_GAP";
  return (
    <tr className={`audit-log__row${dropped ? " audit-log__row--notable" : ""}${isGap ? " audit-log__row--gap" : ""}`}>
      <td className="audit-log__id mono">{ev.id}</td>
      <td className="audit-log__ts mono">{fmt(ev.createdAt)}</td>
      <td className="audit-log__type mono">
        {ev.type}
        {isGap && <span className="audit-log__gap-badge" title="System admitted it lost an event here">⚠</span>}
      </td>
      <td className="audit-log__payload">
        <PayloadSummary payload={ev.payload} />
      </td>
    </tr>
  );
}

function PayloadSummary({ payload }: { payload: Record<string, unknown> }) {
  const parts: string[] = [];
  if (payload.rootCause) parts.push(`root=${payload.rootCause}`);
  if (payload.confidence !== undefined) parts.push(`conf=${payload.confidence}`);
  if (payload.action && typeof payload.action === "object") {
    const a = payload.action as Record<string, unknown>;
    if (a.kind) parts.push(`action=${a.kind}`);
  }
  if (payload.toolCalls !== undefined) parts.push(`tools=${payload.toolCalls}`);
  if (payload.degraded !== undefined) parts.push(`degraded=${payload.degraded}`);
  if (payload.outcome) parts.push(`outcome=${payload.outcome}`);
  if (payload.rule) parts.push(`rule=${payload.rule}`);
  if (payload.status) parts.push(`status=${payload.status}`);
  if (payload.recoveredPaise !== undefined)
    parts.push(`recovered=₹${(Number(payload.recoveredPaise) / 100).toFixed(0)}`);
  if (payload.decision) parts.push(`decision=${payload.decision}`);
  if (payload.approver) parts.push(`approver=${payload.approver}`);
  if (payload.channel) parts.push(`channel=${payload.channel}`);
  if (payload.model) parts.push(`model=${payload.model}`);
  if (payload.detail && typeof payload.detail === "string")
    parts.push(`detail="${payload.detail.slice(0, 60)}${payload.detail.length > 60 ? "…" : ""}"`);
  return <span className="audit-log__payload-text">{parts.join(" · ") || "—"}</span>;
}

export function AuditLog({ events }: { events: StoredEvent[] }) {
  if (events.length === 0) {
    return <p className="empty">No events recorded for this case.</p>;
  }

  const notableCount = events.filter((e) => DROPPED_TYPES.has(e.type)).length;

  return (
    <div className="audit-log">
      <p className="audit-log__meta">
        {events.length} events · {notableCount} suppressed by narrative view
        {notableCount > 0 && (
          <span className="audit-log__meta-hint"> (shown highlighted below)</span>
        )}
      </p>
      <div className="audit-log__scroll">
        <table className="audit-log__table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Timestamp</th>
              <th>Type</th>
              <th>Key fields</th>
            </tr>
          </thead>
          <tbody>
            {events.map((ev) => (
              <EventRow key={ev.id} ev={ev} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
