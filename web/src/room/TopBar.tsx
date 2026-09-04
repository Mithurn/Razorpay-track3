import { useEffect, useRef, useState } from "react";
import { stopAll, resumeAll } from "../api.js";
import { useTweenedNumber } from "./useTweenedNumber.js";
import { Square, ChevronDown, ChevronRight, X } from "../ui/icons.js";
import { Spinner } from "../ui/motion.js";
import type { Lane, RoomMetrics, RunSummary } from "../types.js";

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

const ACTIVE_LANES: Lane[] = ["INCOMING", "DIAGNOSING", "DECIDING", "ATTEMPTING", "RETRY_SCHEDULED"];
const RESOLVED_LANES: Lane[] = ["RECOVERED", "ESCALATED", "WRITTEN_OFF", "STOPPED"];

function count(m: RoomMetrics | null, lanes: Lane[]): number {
  if (!m) return 0;
  return lanes.reduce((sum, lane) => sum + (m.byLane[lane] ?? 0), 0);
}

export function TopBar({
  metrics,
  board,
  onError,
}: {
  metrics: RoomMetrics | null;
  board: { agent?: RunSummary; fixed?: RunSummary; rules?: RunSummary };
  onError: (message: string) => void;
}) {
  const recoveredLivePaise = metrics?.recoveredLivePaise ?? 0;
  const recoveredSimulatedPaise = metrics?.recoveredSimulatedPaise ?? 0;
  // The batch total is the hero figure — it's the number Track 3's bar actually grades ("measured
  // money recovered across a batch"), and it's what the whole evaluation section is about. A real
  // live capture from working `cust_live_demo` on camera is genuine money too, just from a sample
  // of one — shown as a ticking accent underneath, never blended into the batch total (the two
  // are summed from clearly separate sources on purpose; see README's "What's real" section).
  const recoveredLive = useTweenedNumber(recoveredLivePaise);
  const exposure = useTweenedNumber(metrics?.exposurePaise ?? 0);
  const [benchOpen, setBenchOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);

  const recoveredDelta = useRecoveredDelta(metrics ? recoveredLivePaise : null);

  const active = count(metrics, ACTIVE_LANES);
  const resolved = count(metrics, RESOLVED_LANES);
  const recoveredCount = metrics?.byLane.RECOVERED ?? 0;
  const escalated = metrics?.byLane.ESCALATED ?? 0;
  const recoveryRate = resolved > 0 ? recoveredCount / resolved : 0;
  const braked = metrics?.braked ?? false;

  const emergencyStop = async () => {
    setConfirmingStop(false);
    setStopping(true);
    try {
      await stopAll("emergency stop from the room top bar");
    } catch (err) {
      onError(err instanceof Error ? err.message : "stop failed");
    } finally {
      setStopping(false);
    }
  };

  const resume = async () => {
    try {
      await resumeAll();
    } catch (err) {
      onError(err instanceof Error ? err.message : "resume failed");
    }
  };

  return (
    <header className="topbar">
      <div className="topbar__metrics">
        <Metric
          label="Recovered — 60-case batch"
          value={rupees(recoveredSimulatedPaise)}
          tone="recovered"
          note={
            recoveredDelta
              ? `${recoveredDelta} just captured, live`
              : recoveredLivePaise > 0
                ? `+ ${rupees(recoveredLive)} live this session`
                : "no live captures yet this session"
          }
        />
        <Metric label="Exposure at risk" value={rupees(exposure)} tone="plain" />
        <Metric label="Recovery rate" value={resolved > 0 ? pct(recoveryRate) : "—"} tone="plain" />
        <Metric label="Waiting on you" value={String(escalated)} tone={escalated > 0 ? "warn" : "plain"} />
        <Metric label="Active now" value={String(active)} tone="plain" />
      </div>

      <div className="topbar__controls">
        {braked ? (
          <div className="topbar__halted">
            <span>Every live case stopped — permanently. Resume unblocks new cases only, it does not revive these.</span>
            <button className="btn btn--ghost" onClick={resume}>
              Resume new activity
            </button>
          </div>
        ) : confirmingStop ? (
          <div className="topbar__confirm-stop">
            <span>
              Permanently stop all {active} live case{active === 1 ? "" : "s"}? This cannot be undone — Resume only
              allows new cases to start afterward.
            </span>
            <button className="btn btn--danger-solid" onClick={emergencyStop} disabled={stopping}>
              {stopping ? <Spinner size={13} /> : <Square size={13} />}
              {stopping ? "Stopping…" : "Confirm — stop permanently"}
            </button>
            <button className="btn btn--ghost" onClick={() => setConfirmingStop(false)} aria-label="Cancel">
              <X size={13} />
            </button>
          </div>
        ) : (
          <button className="btn btn--stop" onClick={() => setConfirmingStop(true)}>
            <Square size={13} /> Emergency stop
          </button>
        )}
        {board.agent && board.fixed && (
          <button className="btn btn--ghost" onClick={() => setBenchOpen((v) => !v)}>
            Benchmark {benchOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
      </div>

      {benchOpen && board.agent && board.fixed && (
        <BenchPanel agent={board.agent} fixed={board.fixed} rules={board.rules} />
      )}
    </header>
  );
}

function Metric({
  label,
  value,
  tone,
  delta,
  note,
}: {
  label: string;
  value: string;
  tone: "deny" | "plain" | "recovered" | "warn";
  delta?: string | null;
  note?: string | null;
}) {
  return (
    <div className={`metric metric--${tone}`}>
      <span className="metric__value-row">
        <span className="metric__value">{value}</span>
        {delta && <span className="metric__delta">{delta}</span>}
      </span>
      <span className="metric__label">{label}</span>
      {note && <span className="metric__label" style={{ opacity: 0.7 }}>{note}</span>}
    </div>
  );
}

// Shows a brief +₹ delta whenever recovered revenue steps up from a real backend event. The
// first non-zero value is the baseline (page load), not a recovery — only later increases show.
function useRecoveredDelta(recoveredPaise: number | null): string | null {
  const [delta, setDelta] = useState<string | null>(null);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    if (recoveredPaise === null) return;
    const base = prev.current;
    prev.current = recoveredPaise;
    if (base === null) return; // first real reading is the baseline, not a recovery
    const gain = recoveredPaise - base;
    if (gain <= 0) return;
    setDelta(`+${rupees(gain)}`);
    const t = setTimeout(() => setDelta(null), 4000);
    return () => clearTimeout(t);
  }, [recoveredPaise]);
  return delta;
}

// Recorded, not live. Whichever arm actually recovers the most is shown as the finding — not
// hardcoded to the agent.
function BenchPanel({ agent, fixed, rules }: { agent: RunSummary; fixed: RunSummary; rules?: RunSummary }) {
  const arms: { label: string; m: RunSummary }[] = [
    { label: "Agent", m: agent },
    { label: "Fixed schedule", m: fixed },
    ...(rules ? [{ label: "Rules table", m: rules }] : []),
  ];
  const best = arms.reduce((a, b) => (b.m.recoveredPaise > a.m.recoveredPaise ? b : a));

  return (
    <div className="eval-panel">
      <span className="eval-panel__label">
        Recorded benchmark · {agent.cases}-case batch · not live · same gate, executor and ledger, only the brain
        swapped
      </span>
      <div className="eval-panel__row">
        {arms.map(({ label, m }) => (
          <span key={label} className={"eval-panel__arm" + (m === best.m ? "" : " eval-panel__arm--dim")}>
            {label} — {rupees(m.recoveredPaise)} recovered · {pct(m.recoveryRate)} rate · {pct(m.escalationRate)}{" "}
            escalated
            {m.rootCauseAccuracy !== null && ` · ${pct(m.rootCauseAccuracy)} root-cause accuracy`}
          </span>
        ))}
      </div>
      {rules && (
        <span className="eval-panel__label" style={{ opacity: 0.7 }}>
          {best.label} recovers the most on this batch. Root-cause accuracy is the agent-only figure — a fixed
          schedule or a rules table never diagnoses at all, it only picks an action off the error code.
        </span>
      )}
    </div>
  );
}
