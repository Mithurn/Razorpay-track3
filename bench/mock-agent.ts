import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentRunner } from "../src/worker/pipeline.js";
import type { ToolCall, ToolResult } from "../src/agent/recovery-agent.js";
import type { AgentProposal } from "../src/domain/recovery-action.js";

// Record real agent turns once, replay them for free. Keyed by customerRef plus attempt number,
// so a re-plan on attempt 2 is a distinct recorded turn. Each turn keeps the tool-call/result
// trace alongside the proposal, so a replayed case seeding the room fires the same
// TOOL_CALLED/TOOL_RESULT events a live run would. Pre-trace cache files still replay, as zero
// tool events.

type ToolTraceEntry =
  | { type: "TOOL_CALLED"; payload: { name: string; callId: string; args: unknown } }
  | { type: "TOOL_RESULT"; payload: { name: string; callId: string; source: string; raw: unknown; ms: number } };

type RecordedTurn = { proposal: AgentProposal; trace: ToolTraceEntry[] };
type Cache = Record<string, RecordedTurn>;

function key(customerRef: string, attemptNo: number): string {
  return `${customerRef}#${attemptNo}`;
}

// A cache file from before the trace existed stores a bare AgentProposal per key. Read it as a
// turn with an empty trace rather than invalidating every recording made so far.
function normalize(raw: Record<string, unknown>): Cache {
  const out: Cache = {};
  for (const [k, v] of Object.entries(raw)) {
    const entry = v as Record<string, unknown>;
    out[k] = "proposal" in entry ? (entry as RecordedTurn) : { proposal: entry as AgentProposal, trace: [] };
  }
  return out;
}

export function recordingRunner(inner: AgentRunner, path: string): AgentRunner {
  const cache: Cache = existsSync(path) ? normalize(JSON.parse(readFileSync(path, "utf8"))) : {};
  return async (deps, events) => {
    const k = key(deps.kase.customerRef, deps.priorAttempts.length + 1);
    if (cache[k]) return cache[k]!.proposal;

    const trace: ToolTraceEntry[] = [];
    const proposal = await inner(deps, {
      ...events,
      onToolCall: async (call: ToolCall) => {
        trace.push({ type: "TOOL_CALLED", payload: { name: call.name, callId: call.callId, args: call.args } });
        await events.onToolCall?.(call);
      },
      onToolResult: async (r: ToolResult) => {
        trace.push({ type: "TOOL_RESULT", payload: { name: r.name, callId: r.callId, source: r.source, raw: r.raw, ms: r.ms } });
        await events.onToolResult?.(r);
      },
    });
    cache[k] = { proposal, trace };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
    return proposal;
  };
}

export function replayRunner(path: string): AgentRunner {
  if (!existsSync(path)) throw new Error(`--mock needs a recorded run at ${path}; run once without --mock first`);
  const cache: Cache = normalize(JSON.parse(readFileSync(path, "utf8")));
  return async (deps, events) => {
    const k = key(deps.kase.customerRef, deps.priorAttempts.length + 1);
    const hit = cache[k];
    if (!hit) {
      // A case that reached an attempt the recording never saw — degrade rather than call the model.
      return {
        action: { kind: "RETRY_SCHEDULED", atHoursFromNow: 48 },
        diagnosisRootCause: null,
        confidence: 0,
        reasoning: "no recorded turn for this step",
        toolCalls: 0,
        degraded: true,
      };
    }
    // Replay the recorded tool trace through the same events a live run would fire, so a caller
    // seeding durable TOOL_CALLED/TOOL_RESULT rows from them (bench/seed-room.ts) gets real
    // content, not just the final proposal.
    for (const entry of hit.trace) {
      if (entry.type === "TOOL_CALLED") {
        await events?.onToolCall?.({ name: entry.payload.name, callId: entry.payload.callId, args: entry.payload.args });
      } else {
        await events?.onToolResult?.({
          name: entry.payload.name,
          callId: entry.payload.callId,
          source: entry.payload.source as ToolResult["source"],
          raw: entry.payload.raw,
          ms: entry.payload.ms,
        });
      }
    }
    return hit.proposal;
  };
}
