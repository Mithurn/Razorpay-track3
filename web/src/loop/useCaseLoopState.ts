// Pure derivation of the loop-graph state for one case. Folded over the persisted event tape
// (authoritative, so a mid-run reload rebuilds correctly) with the live SSE signals overlaid on
// top for the in-flight portion the tape does not carry yet (tools firing, reasoning head,
// finding count). No React, no I/O — unit-tested in loop.test.ts.

import { RESOLVED_LANES } from "../types.js";

export type StageId = "INCOMING" | "INVESTIGATE" | "PROPOSE" | "GATE" | "EXECUTE" | "OUTCOME";
export type StageStatus = "idle" | "active" | "done" | "failed" | "vetoed";
export type ToolStatus = "idle" | "firing" | "done";

export type EdgeId =
  | "INCOMING-INVESTIGATE"
  | "INVESTIGATE-PROPOSE"
  | "PROPOSE-GATE"
  | "GATE-EXECUTE"
  | "EXECUTE-OUTCOME"
  | "OUTCOME-INVESTIGATE";

export const TOOL_LABELS: Record<string, string> = {
  get_customer_payment_history: "history",
  check_bank_downtime: "downtime",
  get_similar_resolved_cases: "similar",
  get_this_case_prior_attempts: "prior",
  get_recovery_playbook: "playbook",
};
const TOOL_ORDER = Object.keys(TOOL_LABELS);

export type LoopGate = {
  outcome: "allow" | "clamp" | "skip";
  rule?: string | null;
  proposed?: string;
  applied?: string;
  detail?: string | null;
};

export type LoopState = {
  stages: Record<StageId, StageStatus>;
  tools: { name: string; label: string; status: ToolStatus }[];
  findingCount: number;
  reasoningHead: string;
  proposal: { action: string; degraded: boolean } | null;
  gate: LoopGate | null;
  attempt: { status: string; idempotencyKey: string | null; razorpayRef: string | null; recoveredPaise: number } | null;
  replanCount: number;
  finalLane: string | null;
  currentEdge: EdgeId | null;
};

export type LoopEvent = { type: string; payload?: Record<string, unknown> };

export type LiveSignals = {
  running?: boolean;
  reasoning?: string;
  tools?: string[];
  toolResultCount?: number;
  proposalKind?: string | null;
  degraded?: boolean;
  doneLane?: string | null;
};

const REPLAN_LANES = new Set(["RETRY_SCHEDULED"]);
const TERMINAL_LANES = new Set<string>(RESOLVED_LANES);

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function head(text: string, n = 96): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  // track the live thought: show the most recent slice, starting at a word boundary
  const tail = t.slice(t.length - n);
  const cut = tail.indexOf(" ");
  return "…" + (cut > 0 ? tail.slice(cut + 1) : tail);
}

export function emptyLoopState(): LoopState {
  return {
    stages: {
      INCOMING: "idle",
      INVESTIGATE: "idle",
      PROPOSE: "idle",
      GATE: "idle",
      EXECUTE: "idle",
      OUTCOME: "idle",
    },
    tools: TOOL_ORDER.map((name) => ({ name, label: TOOL_LABELS[name]!, status: "idle" as ToolStatus })),
    findingCount: 0,
    reasoningHead: "",
    proposal: null,
    gate: null,
    attempt: null,
    replanCount: 0,
    finalLane: null,
    currentEdge: null,
  };
}

export function deriveLoopState(events: LoopEvent[], live: LiveSignals = {}): LoopState {
  const s = emptyLoopState();
  const set = (id: StageId, status: StageStatus) => {
    s.stages[id] = status;
  };

  const investigations = events.filter((e) => e.type === "INVESTIGATION_STARTED").length;
  const proposedEvent = [...events].reverse().find((e) => e.type === "AGENT_PROPOSED" || e.type === "AGENT_DEGRADED");
  const gateEvent = [...events].reverse().find((e) => e.type === "GATE_APPLIED");
  const outcomeEvents = events.filter((e) => e.type === "ATTEMPT_OUTCOME");
  const lastOutcome = outcomeEvents.at(-1);
  const resolved = [...events].reverse().find((e) => e.type === "CASE_RESOLVED");
  const started = investigations > 0 || live.running === true;

  s.replanCount = Math.max(0, investigations - 1);

  // INCOMING
  set("INCOMING", started ? "done" : "idle");

  // INVESTIGATE
  if (started) set("INVESTIGATE", "active");

  // tool pills — from the live call list while running, else from the recorded tool count
  const liveTools = live.tools ?? [];
  const recordedToolCount = Number((proposedEvent?.payload?.toolCalls as number) ?? 0);
  s.tools = TOOL_ORDER.map((name, i) => {
    let status: ToolStatus = "idle";
    if (liveTools.length > 0) {
      const idx = liveTools.indexOf(name);
      if (idx >= 0) status = proposedEvent || idx < liveTools.length - 1 ? "done" : "firing";
    } else if (i < recordedToolCount) {
      status = "done";
    }
    return { name, label: TOOL_LABELS[name]!, status };
  });

  s.findingCount = live.toolResultCount ?? (liveTools.length ? 0 : recordedToolCount);
  s.reasoningHead = head(live.reasoning || str(proposedEvent?.payload?.reasoning) || "");

  // PROPOSE
  const proposalKind =
    str((proposedEvent?.payload?.action as { kind?: string })?.kind) ?? live.proposalKind ?? undefined;
  const degraded = proposedEvent?.type === "AGENT_DEGRADED" || live.degraded === true;
  if (proposedEvent || live.proposalKind) {
    set("INVESTIGATE", "done");
    set("PROPOSE", degraded ? "failed" : "done");
    s.proposal = { action: proposalKind ?? "?", degraded };
  } else if (started) {
    set("PROPOSE", "idle");
  }

  // GATE
  if (gateEvent) {
    const p = gateEvent.payload ?? {};
    const outcome = (str(p.outcome) ?? "allow") as LoopGate["outcome"];
    s.gate = {
      outcome,
      rule: str(p.rule) ?? null,
      proposed: str(p.proposed),
      applied: str(p.applied),
      detail: str(p.detail) ?? null,
    };
    set("PROPOSE", degraded ? "failed" : "done");
    set("GATE", outcome === "allow" ? "done" : "vetoed");
  } else if (s.proposal) {
    set("GATE", "active");
  }

  // EXECUTE + attempt refs (from live signal or the recorded outcome)
  const startedAttempt = events.some((e) => e.type === "ATTEMPT_STARTED");
  const recRef =
    outcomeEvents.map((e) => str(e.payload?.razorpayRef)).find((r): r is string => Boolean(r)) ?? null;
  const recStatus = str(lastOutcome?.payload?.status);
  const recPaise = Math.max(0, ...outcomeEvents.map((e) => Number(e.payload?.recoveredPaise ?? 0)));
  if (lastOutcome || startedAttempt) {
    s.attempt = {
      status: recStatus ?? "PENDING",
      idempotencyKey: null,
      razorpayRef: recRef,
      recoveredPaise: recPaise,
    };
    set("GATE", s.gate && s.gate.outcome !== "allow" ? "vetoed" : "done");
    if (recStatus === "RECOVERED" || recStatus === "COMPLETED") set("EXECUTE", "done");
    else if (recStatus === "FAILED") set("EXECUTE", s.gate?.outcome === "clamp" ? "vetoed" : "failed");
    else set("EXECUTE", "active");
  } else if (s.gate?.outcome === "skip") {
    set("EXECUTE", "idle");
  } else if (s.gate) {
    set("EXECUTE", "active");
  }

  // OUTCOME
  const lane = str(resolved?.payload?.lane) ?? live.doneLane ?? null;
  s.finalLane = lane;
  if (lane && TERMINAL_LANES.has(lane)) {
    if (s.stages.EXECUTE !== "vetoed" && s.stages.EXECUTE !== "failed") set("EXECUTE", "done");
    set("OUTCOME", lane === "RECOVERED" ? "done" : lane === "ESCALATED" ? "vetoed" : "failed");
  } else if (recStatus === "FAILED" && !lane) {
    set("OUTCOME", "failed");
  } else if (lane && REPLAN_LANES.has(lane)) {
    set("OUTCOME", "active");
  } else if (s.stages.EXECUTE === "done") {
    set("OUTCOME", "active");
  }

  // current animating edge — the frontier, or the replan loop after a failed attempt
  s.currentEdge = pickCurrentEdge(s, { failedAndRetrying: recStatus === "FAILED" && !lane });

  return s;
}

function pickCurrentEdge(s: LoopState, opts: { failedAndRetrying: boolean }): EdgeId | null {
  const st = s.stages;
  if (opts.failedAndRetrying && st.OUTCOME === "failed") return "OUTCOME-INVESTIGATE";
  if (st.OUTCOME === "active") return "EXECUTE-OUTCOME";
  if (st.EXECUTE === "active") return "GATE-EXECUTE";
  if (st.GATE === "active") return "PROPOSE-GATE";
  if (st.PROPOSE === "active") return "INVESTIGATE-PROPOSE";
  if (st.INVESTIGATE === "active" && st.INCOMING === "done") return "INCOMING-INVESTIGATE";
  return null;
}
