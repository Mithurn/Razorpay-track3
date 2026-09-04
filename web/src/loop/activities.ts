// Pure derivation of the unified activity stream from the canonical event log — the same
// StoredEvent[]/AuditEvent[] shape whether the case is being watched live or read back from
// history. No React, no I/O. This replaces the old three-way split (Commentary transcript /
// ConclusionCard / AuditTrail list) with one chronological list of collapsible activities.

import { TOOL_LABELS } from "./useCaseLoopState.js";
import { resultLine } from "./toolLine.js";
import { rupees as sharedRupees } from "../ui/format.js";

export type ActivityKind = "investigate" | "propose" | "gate" | "execute" | "outcome";
export type Tone = "plain" | "clear" | "deny" | "wait" | "info";

export type ToolEntry = {
  callId: string;
  name: string;
  label: string;
  status: "calling" | "done";
  summary: string | null; // resultLine(), once the result lands
  raw: unknown;
  source: "local" | "razorpay-live" | null;
};

export type DetailRow = { label: string; value: string };

export type Activity = {
  id: string;
  kind: ActivityKind;
  title: string;
  status: "active" | "done";
  tone: Tone;
  startedAt: string;
  endedAt: string | null;
  summary: string; // one line, shown once collapsed
  detail: DetailRow[]; // structured rows, shown when expanded
  tools: ToolEntry[]; // only populated for "investigate"
};

export type RawEvent = { type: string; payload: Record<string, unknown>; at: string };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function bool(v: unknown): boolean {
  return v === true;
}
function rupees(paise: unknown): string {
  return sharedRupees(num(paise) ?? 0);
}
function durationMs(startIso: string, endIso: string | null): number | null {
  if (!endIso) return null;
  const ms = Date.parse(endIso) - Date.parse(startIso);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const ACTION_KIND = (payload: Record<string, unknown>): string | undefined => {
  const a = payload.action;
  return a && typeof a === "object" ? str((a as Record<string, unknown>).kind) : undefined;
};

function newInvestigate(ev: RawEvent): Activity {
  return {
    id: `investigate-${ev.at}`,
    kind: "investigate",
    title: "Investigating",
    status: "active",
    tone: "info",
    startedAt: ev.at,
    endedAt: null,
    summary: "",
    detail: [{ label: "attempt", value: String(ev.payload.attemptNo ?? "") }],
    tools: [],
  };
}

function closeInvestigate(a: Activity, reportedToolCalls?: number): void {
  a.status = "done";
  const traced = a.tools.filter((t) => t.status === "done").length;
  // Live runs carry a per-tool trace; recorded batch cases only carry the count on the proposal.
  const n = traced > 0 ? traced : (reportedToolCalls ?? 0);
  a.summary = n > 0 ? `${n} signal${n === 1 ? "" : "s"} checked` : "no signals checked";
}

function newPropose(ev: RawEvent): Activity {
  const p = ev.payload;
  const degraded = ev.type === "AGENT_DEGRADED";
  const rootCause = str(p.rootCause) ?? null;
  const confidence = num(p.confidence) ?? 0;
  const action = ACTION_KIND(p) ?? "?";
  const reasoning = str(p.reasoning) ?? "";
  const toolCalls = num(p.toolCalls) ?? 0;
  return {
    id: `propose-${ev.at}`,
    kind: "propose",
    title: "Diagnosis & proposal",
    status: "done",
    tone: degraded ? "deny" : "plain",
    startedAt: ev.at,
    endedAt: ev.at,
    summary: degraded ? "degraded to a safe fallback — no diagnosis reached" : `${rootCause ?? "?"} → proposes ${action}`,
    detail: [
      { label: "root cause", value: degraded ? "none (degraded)" : (rootCause ?? "—") },
      { label: "confidence", value: degraded ? "—" : confidence.toFixed(2) },
      { label: "proposes", value: action },
      { label: "tool calls", value: String(toolCalls) },
      { label: "reasoning", value: reasoning },
    ],
    tools: [],
  };
}

function newGate(ev: RawEvent): Activity {
  const p = ev.payload;
  const outcome = str(p.outcome) ?? "allow";
  const rule = str(p.rule) ?? null;
  const detailText = str(p.detail) ?? null;
  const proposed = str(p.proposed) ?? "?";
  const applied = str(p.applied) ?? null;
  const tone: Tone = outcome === "allow" ? "clear" : "deny";
  const summary =
    outcome === "allow"
      ? "within every limit — proposal unchanged"
      : outcome === "skip"
        ? `skipped this attempt — ${rule} (${detailText})`
        : `clamped ${proposed} → ${applied} — ${rule}`;
  const detail: DetailRow[] =
    outcome === "allow"
      ? [
          { label: "outcome", value: "allow" },
          { label: "checked", value: "attempt cap · exposure cap · risk hold · cooldown" },
          { label: "action", value: applied ?? proposed },
        ]
      : [
          { label: "outcome", value: outcome },
          { label: "rule", value: rule ?? "—" },
          { label: "detail", value: detailText ?? "—" },
          { label: "proposed", value: proposed },
          { label: "applied", value: applied ?? "—" },
        ];
  return {
    id: `gate-${ev.at}`,
    kind: "gate",
    title: "Safety guardrail",
    status: "done",
    tone,
    startedAt: ev.at,
    endedAt: ev.at,
    summary,
    detail,
    tools: [],
  };
}

function newExecute(ev: RawEvent): Activity {
  const p = ev.payload;
  const action = ACTION_KIND(p) ?? str(p.nudgeChannel) ?? "?";
  const clamped = bool(p.clamped);
  return {
    id: `execute-${ev.at}`,
    kind: "execute",
    title: "Execution",
    status: "active",
    tone: "info",
    startedAt: ev.at,
    endedAt: null,
    summary: "",
    detail: [
      { label: "attempt", value: String(p.attemptNo ?? "") },
      { label: "action", value: action },
      { label: "clamped by gate", value: clamped ? "yes" : "no" },
    ],
    tools: [],
  };
}

function closeExecute(a: Activity, ev: RawEvent): void {
  const p = ev.payload;
  const status = str(p.status) ?? "PENDING";
  const recoveredPaise = num(p.recoveredPaise) ?? 0;
  const ref = str(p.razorpayRef);
  a.status = "done";
  a.endedAt = ev.at;
  a.tone = status === "RECOVERED" || status === "COMPLETED" ? "clear" : status === "FAILED" ? "deny" : "wait";
  a.summary =
    status === "RECOVERED"
      ? `captured ${rupees(recoveredPaise)}${ref ? ` · ${ref}` : ""}`
      : status === "COMPLETED"
        ? `completed${p.detail ? ` — ${p.detail}` : ""}`
        : status === "FAILED"
          ? `failed${p.detail ? ` — ${p.detail}` : ""}`
          : `awaiting settlement${ref ? ` · ${ref}` : ""}`;
  a.detail.push({ label: "status", value: status });
  if (recoveredPaise > 0) a.detail.push({ label: "recovered", value: rupees(recoveredPaise) });
  if (ref) a.detail.push({ label: "razorpay ref", value: ref });
  if (str(p.detail)) a.detail.push({ label: "detail", value: str(p.detail)! });
}

const LANE_VERB: Record<string, string> = {
  RECOVERED: "Recovered",
  ESCALATED: "Escalated to a human",
  WRITTEN_OFF: "Written off",
  STOPPED: "Stopped",
};

function newOutcome(ev: RawEvent, rationale?: string): Activity {
  const p = ev.payload;
  if (ev.type === "CASE_STOPPED") {
    const reason = str(p.reason) ?? "user_requested";
    return {
      id: `outcome-${ev.at}`,
      kind: "outcome",
      title: "Stopped",
      status: "done",
      tone: "deny",
      startedAt: ev.at,
      endedAt: ev.at,
      summary: reason === "user_requested" ? "stopped on your request" : `stopped — ${reason}`,
      detail: [
        { label: "reason", value: reason },
        ...(str(p.note) ? [{ label: "note", value: str(p.note)! }] : []),
      ],
      tools: [],
    };
  }
  const lane = str(p.lane) ?? "";
  const via = str(p.via);
  const tone: Tone = lane === "RECOVERED" ? "clear" : lane === "ESCALATED" ? "wait" : "deny";
  // The event itself carries no reason for escalate / write-off — the "why" is the agent's own
  // diagnosis reasoning from the proposal that led here.
  const why = str(p.reason) ?? (lane !== "RECOVERED" ? rationale : undefined);
  return {
    id: `outcome-${ev.at}`,
    kind: "outcome",
    title: "Outcome",
    status: "done",
    tone,
    startedAt: ev.at,
    endedAt: ev.at,
    summary: LANE_VERB[lane] ?? lane.replace(/_/g, " "),
    detail: [
      { label: "outcome", value: LANE_VERB[lane] ?? lane },
      { label: "decided by", value: via ?? "agent" },
      ...(why ? [{ label: "why", value: why }] : []),
    ],
    tools: [],
  };
}

function lastOfKind(activities: Activity[], kind: ActivityKind): Activity | undefined {
  for (let i = activities.length - 1; i >= 0; i--) {
    const a = activities[i];
    if (a && a.kind === kind) return a;
  }
  return undefined;
}

export function deriveActivities(events: RawEvent[]): Activity[] {
  const activities: Activity[] = [];
  let current: Activity | null = null;
  let currentExecute: Activity | null = null;

  const push = (a: Activity) => {
    activities.push(a);
    current = a;
  };

  for (const ev of events) {
    switch (ev.type) {
      case "INVESTIGATION_STARTED":
        if (current && current.status === "active" && current.kind === "investigate") closeInvestigate(current);
        push(newInvestigate(ev));
        break;

      case "TOOL_CALLED": {
        const target = current?.kind === "investigate" ? current : lastOfKind(activities, "investigate");
        if (!target) break;
        const name = str(ev.payload.name) ?? "?";
        target.tools.push({
          callId: str(ev.payload.callId) ?? "",
          name,
          label: TOOL_LABELS[name] ?? name,
          status: "calling",
          summary: null,
          raw: null,
          source: null,
        });
        break;
      }

      case "TOOL_RESULT": {
        const target = current?.kind === "investigate" ? current : lastOfKind(activities, "investigate");
        if (!target) break;
        const callId = str(ev.payload.callId);
        const entry = target.tools.find((t) => t.callId === callId) ?? target.tools.at(-1);
        if (entry) {
          entry.status = "done";
          entry.summary = resultLine(entry.name, ev.payload.raw);
          entry.raw = ev.payload.raw;
          entry.source = str(ev.payload.source) === "razorpay-live" ? "razorpay-live" : "local";
        }
        break;
      }

      case "AGENT_PROPOSED":
      case "AGENT_DEGRADED":
        if (current && current.status === "active" && current.kind === "investigate")
          closeInvestigate(current, num(ev.payload.toolCalls));
        push(newPropose(ev));
        break;

      case "GATE_APPLIED":
        push(newGate(ev));
        break;

      case "ATTEMPT_STARTED":
        // A repeated ATTEMPT_STARTED for an attempt already in flight (same attemptNo, no outcome
        // yet) is not a new step — keep the one block rather than spawning a second, permanently
        // "running" one.
        if (currentExecute && currentExecute.status === "active") break;
        currentExecute = newExecute(ev);
        activities.push(currentExecute);
        current = currentExecute;
        break;

      case "ATTEMPT_OUTCOME":
        if (currentExecute && currentExecute.status === "active") closeExecute(currentExecute, ev);
        currentExecute = null;
        break;

      case "CASE_RESOLVED":
      case "CASE_STOPPED": {
        const proposal = lastOfKind(activities, "propose");
        const rationale = proposal?.detail.find((d) => d.label === "reasoning")?.value;
        push(newOutcome(ev, rationale && rationale !== "—" ? rationale : undefined));
        break;
      }

      default:
        break; // CASE_LANE_CHANGED and CASE_CREATED are structural, not shown in the narrative stream
    }
  }

  // Once the case has a terminal outcome, nothing is still running — force any block left
  // "active" (a dropped stream, a malformed tape) to done so the UI never shows a phantom spinner
  // under a resolved case.
  const settled = activities.some((a) => a.kind === "outcome");
  if (settled) {
    for (const a of activities) {
      if (a.status !== "active") continue;
      if (a.kind === "investigate") closeInvestigate(a);
      else {
        a.status = "done";
        if (!a.endedAt) a.endedAt = a.startedAt;
        if (!a.summary) a.summary = "completed";
      }
    }
  }

  return activities;
}

export function activityDurationMs(a: Activity): number | null {
  return durationMs(a.startedAt, a.endedAt);
}
