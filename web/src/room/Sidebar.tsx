import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decide } from "../api.js";
import { Play, PanelLeftClose, PanelLeftOpen, LayoutList, Inbox, RotateCw } from "../ui/icons.js";
import type { Lane, RecoveryCase } from "../types.js";
import { customerLabel, rupees } from "../ui/format.js";

const LANE_ORDER: Lane[] = [
  "INCOMING",
  "DIAGNOSING",
  "DECIDING",
  "ATTEMPTING",
  "RETRY_SCHEDULED",
  "RECOVERED",
  "ESCALATED",
  "WRITTEN_OFF",
  "STOPPED",
];

type Filter = "all" | "RECOVERED" | "ESCALATED" | "WRITTEN_OFF" | "STOPPED";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "RECOVERED", label: "Recovered" },
  { key: "ESCALATED", label: "Escalated" },
  { key: "WRITTEN_OFF", label: "Written off" },
  { key: "STOPPED", label: "Stopped" },
];


const LANE_DOT: Partial<Record<Lane, string>> = {
  RECOVERED: "clear",
  ESCALATED: "deny",
  STOPPED: "deny",
  WRITTEN_OFF: "deny",
  RETRY_SCHEDULED: "wait",
  DIAGNOSING: "agent",
  DECIDING: "agent",
  ATTEMPTING: "agent",
};

const MIN_WIDTH = 232;
const MAX_WIDTH = 460;
const DEFAULT_WIDTH = 288;
const COLLAPSED_WIDTH = 56;

function readStored<T>(key: string, fallback: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : parse(raw);
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode / disabled storage — the sidebar still works, it just won't persist */
  }
}

function liveState(connected: boolean, braked: boolean): { key: string; label: string } {
  if (!connected) return { key: "offline", label: "Offline" };
  if (braked) return { key: "stopped", label: "Stopped" };
  return { key: "live", label: "Live" };
}

export function Sidebar({
  connected,
  braked,
  cases,
  escalations,
  selected,
  onSelect,
  freshCase,
  onWatchLive,
  onEscalationDone,
  onError,
}: {
  connected: boolean;
  braked: boolean;
  cases: RecoveryCase[];
  escalations: RecoveryCase[];
  selected: string | null;
  onSelect: (id: string) => void;
  freshCase: RecoveryCase | undefined;
  onWatchLive: () => void;
  onEscalationDone: () => void;
  onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<"flow" | "waiting">("flow");
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState(() =>
    readStored("rr.sidebar.collapsed", false, (r) => r === "1"),
  );
  const [width, setWidth] = useState(() =>
    readStored("rr.sidebar.width", DEFAULT_WIDTH, (r) => {
      const n = Number(r);
      return Number.isFinite(n) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n)) : DEFAULT_WIDTH;
    }),
  );
  const dragging = useRef(false);

  useEffect(() => writeStored("rr.sidebar.collapsed", collapsed ? "1" : "0"), [collapsed]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX - 16)));
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setWidth((w) => {
        writeStored("rr.sidebar.width", String(Math.round(w)));
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const byLane = useMemo(() => {
    const map = new Map<Lane, RecoveryCase[]>();
    for (const l of LANE_ORDER) map.set(l, []);
    for (const c of cases) map.get(c.lane)?.push(c);
    return map;
  }, [cases]);

  const filtered = useMemo(
    () => (filter === "all" ? [] : cases.filter((c) => c.lane === filter)),
    [cases, filter],
  );

  const open = (t: "flow" | "waiting") => {
    setTab(t);
    setCollapsed(false);
  };

  const status = liveState(connected, braked);

  if (collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed" style={{ width: COLLAPSED_WIDTH }}>
        <button className="sidebar__rail-btn" onClick={() => setCollapsed(false)} aria-label="Expand sidebar">
          <PanelLeftOpen size={16} />
        </button>
        <span className={`live-pill live-pill--${status.key} live-pill--rail`} title={status.label}>
          <span className="live-pill__dot" />
        </span>
        <button className="sidebar__rail-btn" onClick={() => open("flow")} aria-label="Case flow">
          <LayoutList size={16} />
          <span className="sidebar__rail-count">{cases.length}</span>
        </button>
        <button className="sidebar__rail-btn" onClick={() => open("waiting")} aria-label="Waiting on you">
          <Inbox size={16} />
          {escalations.length > 0 && <span className="sidebar__badge sidebar__badge--rail">{escalations.length}</span>}
        </button>
      </aside>
    );
  }

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar__brand">
        <span className="sidebar__mark" aria-hidden>
          <RotateCw size={14} />
        </span>
        <span className="brand__name">Recovery Room</span>
        <span className={`live-pill live-pill--${status.key}`}>
          <span className="live-pill__dot" />
          {status.label}
        </span>
        <button className="sidebar__collapse" onClick={() => setCollapsed(true)} aria-label="Collapse sidebar">
          <PanelLeftClose size={15} />
        </button>
      </div>

      <div className="sidebar__tabs">
        <button
          className={"sidebar__tab" + (tab === "flow" ? " sidebar__tab--active" : "")}
          onClick={() => setTab("flow")}
        >
          Case flow <span className="pill-count">{cases.length}</span>
        </button>
        <button
          className={"sidebar__tab" + (tab === "waiting" ? " sidebar__tab--active" : "")}
          onClick={() => setTab("waiting")}
        >
          Waiting on you
          {escalations.length > 0 && <span className="sidebar__badge">{escalations.length}</span>}
        </button>
      </div>

      {tab === "flow" && (
        <div className="sidebar__filters">
          {FILTERS.map((f) => {
            const n = f.key === "all" ? cases.length : (byLane.get(f.key as Lane)?.length ?? 0);
            return (
              <button
                key={f.key}
                className={"filter-chip" + (filter === f.key ? " filter-chip--on" : "")}
                onClick={() => setFilter(f.key)}
              >
                {f.label} <span className="filter-chip__n">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {freshCase && (
        <button className="btn btn--primary sidebar__watch" onClick={onWatchLive}>
          <Play size={13} /> Watch a live recovery
        </button>
      )}

      <div className="sidebar__body">
        {tab === "waiting" ? (
          escalations.length === 0 ? (
            <p className="empty">
              Nothing needs a human right now. When the agent hits a risk hold, or genuinely
              can't tell what to do, the case takes a seat here.
            </p>
          ) : (
            escalations.map((c) => (
              <EscalationRow
                key={c.id}
                kase={c}
                onDone={onEscalationDone}
                onOpen={() => onSelect(c.id)}
                onError={onError}
              />
            ))
          )
        ) : filter !== "all" ? (
          filtered.length === 0 ? (
            <p className="empty">No cases in this state.</p>
          ) : (
            <div className="lane">
              {filtered.map((c) => (
                <CaseCard key={c.id} kase={c} selected={selected === c.id} onSelect={onSelect} />
              ))}
            </div>
          )
        ) : (
          LANE_ORDER.map((lane) => {
            const list = byLane.get(lane) ?? [];
            if (list.length === 0) return null;
            return (
              <div className="lane" key={lane}>
                <div className="lane__head">
                  <span>{lane.replace(/_/g, " ")}</span>
                  <span className="lane__count">{list.length}</span>
                </div>
                {list.slice(0, 12).map((c) => (
                  <CaseCard key={c.id} kase={c} selected={selected === c.id} onSelect={onSelect} />
                ))}
                {list.length > 12 && <span className="card__reason">+{list.length - 12} more</span>}
              </div>
            );
          })
        )}
      </div>

      <div
        className="sidebar__resize"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />
    </aside>
  );
}

function CaseCard({
  kase: c,
  selected,
  onSelect,
}: {
  kase: RecoveryCase;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <div
      className={"card" + (selected ? " card--active" : "")}
      onClick={() => onSelect(c.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(c.id))}
    >
      <div className="card__row">
        <span className="card__cust">
          {LANE_DOT[c.lane] && <span className={`card__dot card__dot--${LANE_DOT[c.lane]}`} aria-hidden />}
          {customerLabel(c.customerRef)}
        </span>
        <span className="card__amount">
          {c.lane === "RECOVERED" ? rupees(c.recoveredPaise) : rupees(c.amountPaise)}
        </span>
      </div>
      <span className="card__reason">
        {c.failureReason.replace(/_/g, " ")}
        {c.instrument?.issuer ? ` · ${c.instrument.issuer}` : ""}
      </span>
    </div>
  );
}

function EscalationRow({
  kase,
  onDone,
  onOpen,
  onError,
}: {
  kase: RecoveryCase;
  onDone: () => void;
  onOpen: () => void;
  onError: (message: string) => void;
}) {
  const act = async (decision: "approve" | "redirect" | "write_off", redirectTo?: string) => {
    try {
      await decide(kase.id, { decision, redirectTo });
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "request failed");
    }
  };
  return (
    <div className="rail-item">
      <div className="card__row" onClick={onOpen} style={{ cursor: "pointer" }}>
        <span className="card__cust">{customerLabel(kase.customerRef)}</span>
        <span className="card__amount">{rupees(kase.amountPaise)}</span>
      </div>
      <span className="card__reason">{kase.failureReason.replace(/_/g, " ")}</span>
      <div className="rail-item__actions">
        <button className="btn btn--primary" onClick={() => act("approve")}>
          Retry
        </button>
        <button className="btn" onClick={() => act("redirect", "PAYMENT_LINK")}>
          Send link
        </button>
        <button className="btn" onClick={() => act("write_off")}>
          Write off
        </button>
      </div>
    </div>
  );
}
