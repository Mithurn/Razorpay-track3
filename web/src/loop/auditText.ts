// Every recovery_events row rendered as a human sentence with real values, not the enum name.
// This is the decision trail a payments engineer reads.

export type AuditRow = { eventType: string; payload: Record<string, unknown>; at: string };
export type AuditLimits = { maxAttempts: number; maxExposurePaise: number; cooldownHours: number };

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const shortId = (v: unknown) => (typeof v === "string" && v.length > 12 ? v.slice(0, 12) + "…" : String(v ?? ""));

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export type AuditSentence = { text: string; tone: "plain" | "clear" | "deny" };

export function auditSentence(row: AuditRow, limits: AuditLimits): AuditSentence {
  const p = row.payload;
  const plain = (text: string): AuditSentence => ({ text, tone: "plain" });

  switch (row.eventType) {
    case "CASE_CREATED":
      return plain("Case created");

    case "INVESTIGATION_STARTED":
      return plain(`Investigation started — attempt ${p.attemptNo ?? "?"} of ${limits.maxAttempts}`);

    case "AGENT_PROPOSED": {
      const conf = typeof p.confidence === "number" ? ` · confidence ${p.confidence.toFixed(2)}` : "";
      const kind = rec(p.action).kind ?? p.action ?? "?";
      return plain(
        `Agent proposed ${kind} · root cause ${p.rootCause ?? "undiagnosed"}${conf} · ${p.toolCalls ?? 0} tool calls`,
      );
    }

    case "AGENT_DEGRADED": {
      const kind = rec(p.action).kind ?? "RETRY_SCHEDULED";
      return { text: `Agent degraded to a safe fallback (${kind}) — no diagnosis reached`, tone: "deny" };
    }

    case "GATE_APPLIED": {
      const outcome = String(p.outcome ?? "allow");
      if (outcome === "allow") {
        return {
          text: `Safety gate — passed ${p.applied} unchanged (within attempt cap ${limits.maxAttempts}, under ${rupees(
            limits.maxExposurePaise,
          )} exposure cap, ${limits.cooldownHours}h cooldown clear)`,
          tone: "clear",
        };
      }
      if (outcome === "skip") {
        return { text: `Safety gate — skipped this attempt (${p.reason})`, tone: "deny" };
      }
      return { text: `Safety gate — clamped ${p.proposed} to ${p.applied} (${p.reason})`, tone: "deny" };
    }

    case "ATTEMPT_STARTED": {
      const kind = rec(p.action).kind ?? "?";
      const clamped = p.clamped ? " (clamped by the gate)" : "";
      return plain(`Attempt #${p.attemptNo} started — ${kind}${clamped}`);
    }

    case "ATTEMPT_OUTCOME": {
      const status = String(p.status ?? "");
      const ref = p.razorpayRef ? ` · ${shortId(p.razorpayRef)}` : "";
      if (status === "RECOVERED") {
        return {
          text: `Attempt #${p.attemptNo} — captured ${rupees(Number(p.recoveredPaise ?? 0))}${ref} · confirmed by signed webhook`,
          tone: "clear",
        };
      }
      if (status === "FAILED") {
        return { text: `Attempt #${p.attemptNo} — ${p.detail ?? "failed"}`, tone: "deny" };
      }
      return plain(`Attempt #${p.attemptNo} — awaiting settlement${ref}`);
    }

    case "CASE_RESOLVED": {
      const lane = String(p.lane ?? "");
      const via = p.via === "human" ? " · by a reviewer" : "";
      const reason = p.reason ? ` (${p.reason})` : "";
      return {
        text: `Case resolved — ${lane}${reason}${via}`,
        tone: lane === "RECOVERED" ? "clear" : lane === "ESCALATED" ? "plain" : "deny",
      };
    }

    default:
      return plain(row.eventType);
  }
}

export function relativeDelta(fromIso: string, toIso: string): string {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `+${s}s`;
  const m = Math.floor(s / 60);
  return `+${m}m ${s % 60}s`;
}
