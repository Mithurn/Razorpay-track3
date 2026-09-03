import { useEffect, useReducer } from "react";
import { streamCase } from "../api.js";
import type { AuditEvent, ProposalEvent, StreamEvent, ToolResultEvent } from "../types.js";
import { actLine, resultLine } from "./toolLine.js";

// One line in the live commentary. `think` lines are the model's own staccato narration;
// `act`/`result` come from the tool events.
export type CommentaryLine = { id: number; kind: "act" | "result" | "think"; text: string };

export type LiveRun = {
  open: boolean;
  live: boolean;
  reasoning: string;
  tools: string[];
  toolResults: ToolResultEvent[];
  commentary: CommentaryLine[];
  proposal: ProposalEvent | null;
  audit: AuditEvent[];
  doneLane: string | null;
  startedAt: number | null;
  concludedAt: number | null;
};

const EMPTY: LiveRun = {
  open: false,
  live: false,
  reasoning: "",
  tools: [],
  toolResults: [],
  commentary: [],
  proposal: null,
  audit: [],
  doneLane: null,
  startedAt: null,
  concludedAt: null,
};

type Internal = LiveRun & { thinkBuffer: string; nextId: number };

// Flush completed sentences out of the reasoning buffer as short `think` lines.
function drainThinking(state: Internal): Internal {
  const parts = state.thinkBuffer.split(/(?<=[.!?])\s+|\n+/);
  if (parts.length < 2) return state;
  const complete = parts.slice(0, -1);
  const lines: CommentaryLine[] = [];
  let id = state.nextId;
  for (const raw of complete) {
    const text = raw.trim();
    if (text.length < 4) continue;
    lines.push({ id: id++, kind: "think", text: text.length > 120 ? text.slice(0, 120) + "…" : text });
  }
  return {
    ...state,
    thinkBuffer: parts[parts.length - 1] ?? "",
    commentary: [...state.commentary, ...lines],
    nextId: id,
  };
}

// Opening a stream is not evidence that anything is running. A run is live only once the server
// says the case is in flight, or an actual agent signal arrives — the stream carries no history,
// so any of these means work is happening right now.
function running(state: Internal): Internal {
  return state.live ? state : { ...state, live: true, startedAt: state.startedAt ?? Date.now() };
}

function reduce(state: Internal, ev: StreamEvent): Internal {
  switch (ev.type) {
    case "open":
      return { ...state, open: true };

    case "status":
      return ev.active ? running(state) : state;

    case "reasoning":
      return drainThinking({
        ...running(state),
        reasoning: state.reasoning + ev.text,
        thinkBuffer: state.thinkBuffer + ev.text,
      });

    case "tool": {
      if (state.tools.includes(ev.name)) return state;
      return {
        ...running(state),
        tools: [...state.tools, ev.name],
        commentary: [...state.commentary, { id: state.nextId, kind: "act", text: actLine(ev.name) }],
        nextId: state.nextId + 1,
      };
    }

    case "tool_result":
      return {
        ...running(state),
        toolResults: [...state.toolResults, ev],
        commentary: [...state.commentary, { id: state.nextId, kind: "result", text: resultLine(ev.name, ev.raw) }],
        nextId: state.nextId + 1,
      };

    case "proposal":
      return { ...running(state), proposal: ev, concludedAt: Date.now() };

    // Audit mirrors every appended event, including ones a webhook or a human decision raises on
    // a case nobody is investigating. Only the turn's own opening event means a run just began.
    case "audit": {
      const next = ev.eventType === "INVESTIGATION_STARTED" ? running(state) : state;
      return { ...next, audit: [...state.audit, ev] };
    }

    // Only a resolved case has a final lane; the other reasons end this turn with the case still
    // open, and letting them set doneLane would draw a finished run that has not finished.
    case "done":
      return {
        ...state,
        live: false,
        doneLane: ev.reason === "resolved" ? ev.lane : state.doneLane,
        concludedAt: state.concludedAt ?? Date.now(),
      };

    default:
      return state;
  }
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 8000;

export function useLiveRun(caseId: string | null): LiveRun {
  const [state, dispatch] = useReducer(
    (s: Internal, action: StreamEvent | { type: "__reset" }) =>
      action.type === "__reset" ? { ...EMPTY, thinkBuffer: "", nextId: 0 } : reduce(s, action),
    { ...EMPTY, thinkBuffer: "", nextId: 0 },
  );

  useEffect(() => {
    dispatch({ type: "__reset" });
    if (!caseId) return;
    const controller = new AbortController();
    let cancelled = false;
    let done = false;

    // Only a `done` event means the run is over; any other stream end gets a bounded reconnect.
    (async () => {
      for (let attempt = 0; !cancelled && !done && attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (cancelled) return;
        }
        try {
          for await (const ev of streamCase(caseId, controller.signal)) {
            if (cancelled) return;
            if (ev.type === "done") done = true;
            attempt = 0;
            dispatch(ev);
          }
        } catch {
          /* dropped connection or abort; loop reconnects unless cancelled or done */
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [caseId]);

  return state;
}
