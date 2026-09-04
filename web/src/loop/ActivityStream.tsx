import { useState } from "react";
import { activityDurationMs, fmtDuration, type Activity, type ToolEntry } from "./activities.js";
import { resultFields } from "./toolLine.js";
import { ACTIVITY_ICON, Check, ChevronDown, ChevronRight } from "../ui/icons.js";
import { motion, AnimatePresence, blockIn, Spinner, StreamingText } from "../ui/motion.js";

// The hero: one chronological, collapsible list of what the agent did. Live narration streams
// inside the active block; every finished block collapses to one sentence with a duration and a
// tool count, expandable back to the structured detail. No raw chain-of-thought — the narration
// line here is the model's own short text while it's genuinely still running, never persisted,
// never shown once a block collapses.

export function ActivityStream({
  activities,
  liveNarration,
  liveStepStatus,
}: {
  activities: Activity[];
  liveNarration: string;
  liveStepStatus: { step: number; budget: number; elapsedMs: number } | null;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (activities.length === 0) {
    return <p className="empty">Nothing has happened on this case yet.</p>;
  }

  return (
    <ol className="activity-stream">
      <AnimatePresence initial={false}>
        {activities.map((a) => (
          <ActivityBlock
            key={a.id}
            activity={a}
            isOpen={a.status === "active" || expanded.has(a.id)}
            onToggle={() => toggle(a.id)}
            liveNarration={a.status === "active" && a.kind === "investigate" ? liveNarration : ""}
            liveStepStatus={a.status === "active" && a.kind === "investigate" ? liveStepStatus : null}
          />
        ))}
      </AnimatePresence>
    </ol>
  );
}

function ActivityBlock({
  activity: a,
  isOpen,
  onToggle,
  liveNarration,
  liveStepStatus,
}: {
  activity: Activity;
  isOpen: boolean;
  onToggle: () => void;
  liveNarration: string;
  liveStepStatus: { step: number; budget: number; elapsedMs: number } | null;
}) {
  const duration = activityDurationMs(a);
  const canToggle = a.status === "done";
  const Icon = ACTIVITY_ICON[a.kind];
  const Chevron = isOpen ? ChevronDown : ChevronRight;
  return (
    <motion.li layout className={`act act--${a.tone} act--${a.status}`} {...blockIn}>
      <span className={"act__rail" + (a.status === "active" ? " act__rail--active" : "")} aria-hidden />
      <button className="act__head" onClick={canToggle ? onToggle : undefined} disabled={!canToggle} aria-expanded={isOpen}>
        <span className="act__icon" aria-hidden>
          {a.status === "active" ? <Spinner size={15} /> : <Icon size={15} />}
        </span>
        <span className="act__title">{a.title}</span>
        {a.status === "done" && (
          <span className="act__summary">
            {a.summary}
            {duration !== null && <span className="act__meta"> · {fmtDuration(duration)}</span>}
            {a.tools.length > 0 && <span className="act__meta"> · {a.tools.length} tool{a.tools.length === 1 ? "" : "s"}</span>}
          </span>
        )}
        {a.status === "active" && liveStepStatus && (
          <span className="act__live-status">
            step {liveStepStatus.step}/{liveStepStatus.budget} · {(liveStepStatus.elapsedMs / 1000).toFixed(1)}s
          </span>
        )}
        {canToggle && <Chevron size={14} className="act__chevron" />}
      </button>

      {isOpen && (
        <div className="act__body">
          {a.tools.length > 0 && (
            <ul className="act__tools">
              {a.tools.map((t) => (
                <ToolRow key={t.callId || t.name} tool={t} />
              ))}
            </ul>
          )}
          {liveNarration && (
            <p className="act__narration">
              <StreamingText text={liveNarration} />
            </p>
          )}
          {a.status === "done" && a.detail.length > 0 && <DetailTable rows={a.detail} />}
        </div>
      )}
    </motion.li>
  );
}

function ToolRow({ tool }: { tool: ToolEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="tool-row">
      <button className="tool-row__head" onClick={() => tool.status === "done" && setOpen((v) => !v)}>
        <span className={"tool-row__mark" + (tool.status === "done" ? " tool-row__mark--done" : "")}>
          {tool.status === "done" ? <Check size={12} /> : <Spinner size={11} />}
        </span>
        <span className="tool-row__label">{tool.label}</span>
        {tool.source === "razorpay-live" && (
          <span className="tool-row__src tool-row__src--live">Razorpay live</span>
        )}
        {tool.summary && <span className="tool-row__summary">{tool.summary}</span>}
      </button>
      {open && tool.status === "done" && (
        <DetailTable
          rows={resultFields({ type: "tool_result", name: tool.name, source: tool.source ?? "local", raw: tool.raw, ms: 0 })}
        />
      )}
    </li>
  );
}

function DetailTable({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="detail-table">
      {rows.map((r) => (
        <div className="detail-table__row" key={r.label}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
