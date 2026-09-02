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

function reduce(state: Internal, ev: StreamEvent): Internal {
  switch (ev.type) {
    case "open":
      return { ...state, open: true, live: true, startedAt: state.startedAt ?? Date.now() };

    case "reasoning":
      return drainThinking({ ...state, reasoning: state.reasoning + ev.text, thinkBuffer: state.thinkBuffer + ev.text });

    case "tool": {
      if (state.tools.includes(ev.name)) return state;
      return {
        ...state,
        tools: [...state.tools, ev.name],
        commentary: [...state.commentary, { id: state.nextId, kind: "act", text: actLine(ev.name) }],
        nextId: state.nextId + 1,
      };
    }

    case "tool_result":
      return {
        ...state,
        toolResults: [...state.toolResults, ev],
        commentary: [...state.commentary, { id: state.nextId, kind: "result", text: resultLine(ev.name, ev.raw) }],
        nextId: state.nextId + 1,
      };

    case "proposal":
      return { ...state, proposal: ev, concludedAt: Date.now() };

    case "audit":
      return { ...state, audit: [...state.audit, ev] };

    case "done":
      return { ...state, live: false, doneLane: ev.lane, concludedAt: state.concludedAt ?? Date.now() };

    default:
      return state;
  }
}

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
    (async () => {
      try {
        for await (const ev of streamCase(caseId, controller.signal)) dispatch(ev);
      } catch {
        /* aborted */
      }
    })();
    return () => controller.abort();
  }, [caseId]);

  return state;
}
