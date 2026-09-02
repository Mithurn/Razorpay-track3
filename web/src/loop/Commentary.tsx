import { useEffect, useRef, useState } from "react";
import type { CommentaryLine } from "./useLiveRun.js";

const VISIBLE = 6;

export function Commentary({
  lines,
  status,
}: {
  lines: CommentaryLine[];
  status: { stage: string; step: number; budget: number; toolCalls: number; elapsedMs: number } | null;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div
        className="cmt"
        onClick={() => setExpanded(true)}
        title="Click to expand the full investigation transcript"
      >
        {status && (
          <div className="cmt__status">
            <span className="cmt__spin">✻</span>
            {status.stage} · step {status.step}/{status.budget} · {status.toolCalls} tool call
            {status.toolCalls === 1 ? "" : "s"} · {(status.elapsedMs / 1000).toFixed(1)}s
            <span className="cmt__expand">⤢</span>
          </div>
        )}
        <div className="cmt__lines">
          {lines.slice(-VISIBLE).map((l, i, a) => (
            <div
              key={l.id}
              className={`cmt__line cmt__line--${l.kind}`}
              style={{ opacity: i === 0 && a.length === VISIBLE ? 0.35 : i === 1 && a.length === VISIBLE ? 0.6 : 1 }}
            >
              {l.text}
            </div>
          ))}
        </div>
      </div>
      {expanded && <CommentaryDrawer lines={lines} status={status} onClose={() => setExpanded(false)} />}
    </>
  );
}

function CommentaryDrawer({
  lines,
  status,
  onClose,
}: {
  lines: CommentaryLine[];
  status: { stage: string; step: number; budget: number; toolCalls: number; elapsedMs: number } | null;
  onClose: () => void;
}) {
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cmt-drawer">
      <div className="cmt-drawer__head">
        <span className="cmt-drawer__title">
          investigation transcript
          {status ? ` · ${status.stage}` : ""}
        </span>
        <button className="cmt-drawer__close" onClick={onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="cmt-drawer__body">
        {lines.length === 0 && <p className="cmt-drawer__empty">No commentary recorded yet.</p>}
        {lines.map((l) => (
          <div key={l.id} className={`cmt__line cmt__line--${l.kind}`}>
            {l.text}
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}
