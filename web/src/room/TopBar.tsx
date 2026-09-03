import { useState } from "react";
import { stopAll, resumeAll } from "../api.js";
import { useTweenedNumber } from "./useTweenedNumber.js";
import type { Lane, RoomMetrics, RunSummary } from "../types.js";

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

const ACTIVE_LANES: Lane[] = ["INCOMING", "DIAGNOSING", "DECIDING", "ATTEMPTING", "RETRY_SCHEDULED"];

function count(m: RoomMetrics | null, lanes: Lane[]): number {
  if (!m) return 0;
  return lanes.reduce((sum, lane) => sum + (m.byLane[lane] ?? 0), 0);
}

export function TopBar({
  metrics,
  connected,
  board,
  onError,
}: {
  metrics: RoomMetrics | null;
  connected: boolean;
  board: { agent?: RunSummary; fixed?: RunSummary };
  onError: (message: string) => void;
}) {
  const recovered = useTweenedNumber(metrics?.recoveredPaise ?? 0);
  const exposure = useTweenedNumber(metrics?.exposurePaise ?? 0);
  const [evalOpen, setEvalOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [halted, setHalted] = useState<number | null>(null);

  const active = count(metrics, ACTIVE_LANES);
  const recoveredCount = metrics?.byLane.RECOVERED ?? 0;
  const escalated = metrics?.byLane.ESCALATED ?? 0;
  const stopped = metrics?.byLane.STOPPED ?? 0;

  const emergencyStop = async () => {
    setStopping(true);
    try {
      const { stoppedNow } = await stopAll("emergency stop from the room top bar");
      setHalted(stoppedNow);
    } catch (err) {
      onError(err instanceof Error ? err.message : "stop failed");
    } finally {
      setStopping(false);
    }
  };

  const resume = async () => {
    try {
      await resumeAll();
      setHalted(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : "resume failed");
    }
  };

  return (
    <header className="topbar">
      <div className="topbar__brand">
        <span className="brand__name">Recovery Room</span>
        <span className={"topbar__live" + (connected ? " topbar__live--on" : "")}>
          <span className="topbar__live-dot" />
          {connected ? "live" : "reconnecting…"}
        </span>
      </div>

      <div className="topbar__metrics">
        <Metric label="recovered" value={rupees(recovered)} tone="clear" />
        <Metric label="exposure at risk" value={rupees(exposure)} tone="wait" />
        <Metric label="recovered cases" value={String(recoveredCount)} tone="clear" />
        <Metric label="active" value={String(active)} tone="info" />
        <Metric label="waiting on you" value={String(escalated)} tone={escalated > 0 ? "deny" : "plain"} />
        {stopped > 0 && <Metric label="stopped" value={String(stopped)} tone="deny" />}
      </div>

      <div className="topbar__controls">
        {halted !== null ? (
          <div className="topbar__halted">
            <span>
              room stopped · {halted} case{halted === 1 ? "" : "s"} halted immediately
            </span>
            <button className="btn btn--ghost" onClick={resume}>
              resume
            </button>
          </div>
        ) : (
          <button className="btn btn--stop" onClick={emergencyStop} disabled={stopping}>
            {stopping ? "stopping…" : "emergency stop"}
          </button>
        )}
        {board.agent && board.fixed && (
          <button className="btn btn--ghost topbar__eval-toggle" onClick={() => setEvalOpen((v) => !v)}>
            batch eval {evalOpen ? "▴" : "▾"}
          </button>
        )}
      </div>

      {evalOpen && board.agent && board.fixed && <EvalPanel agent={board.agent} fixed={board.fixed} />}
    </header>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: "clear" | "wait" | "info" | "deny" | "plain" }) {
  return (
    <div className={`metric metric--${tone}`}>
      <span className="metric__value">{value}</span>
      <span className="metric__label">{label}</span>
    </div>
  );
}

// Secondary, collapsed by default — this is the project's actual empirical finding (the agent
// beating a fixed retry schedule on a recorded batch), kept visible in-app but never presented
// as a live number: there is no live control arm to honestly compare against.
function EvalPanel({ agent, fixed }: { agent: RunSummary; fixed: RunSummary }) {
  const delta = agent.recoveredPaise - fixed.recoveredPaise;
  return (
    <div className="eval-panel">
      <span className="eval-panel__label">
        agent vs fixed retry schedule · recorded batch of {agent.cases} · not a live comparison
      </span>
      <div className="eval-panel__row">
        <span className="eval-panel__arm">
          agent — {rupees(agent.recoveredPaise)} · {pct(agent.recoveryRate)} recovered · {pct(agent.escalationRate)} escalated
        </span>
        <span className="eval-panel__arm eval-panel__arm--dim">
          fixed — {rupees(fixed.recoveredPaise)} · {pct(fixed.recoveryRate)} recovered · {pct(fixed.escalationRate)} escalated
        </span>
        <span className="eval-panel__delta">+{rupees(Math.max(delta, 0))} recovered by the agent</span>
      </div>
    </div>
  );
}
