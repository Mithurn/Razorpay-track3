import { useEffect, useRef } from "react";
import type { CommentaryLine } from "./useLiveRun.js";

const VISIBLE = 6;

export function Commentary({
  lines,
  status,
}: {
  lines: CommentaryLine[];
  status: { stage: string; step: number; budget: number; toolCalls: number; elapsedMs: number } | null;
}) {
  const seen = lines.slice(-VISIBLE);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  return (
    <div className="cmt">
      {status && (
        <div className="cmt__status">
          <span className="cmt__spin">✻</span>
          {status.stage} · step {status.step}/{status.budget} · {status.toolCalls} tool call
          {status.toolCalls === 1 ? "" : "s"} · {(status.elapsedMs / 1000).toFixed(1)}s
        </div>
      )}
      <div className="cmt__lines">
        {seen.map((l, i) => (
          <div
            key={l.id}
            className={`cmt__line cmt__line--${l.kind}`}
            style={{ opacity: i === 0 && seen.length === VISIBLE ? 0.35 : i === 1 && seen.length === VISIBLE ? 0.6 : 1 }}
          >
            {l.text}
          </div>
        ))}
        <div ref={bottom} />
      </div>
    </div>
  );
}
