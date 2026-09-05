import { useCallback, useEffect, useState } from "react";
import "./styles/room.css";
import "./loop/loop.css";
import "./room/room-extra.css";
import { AttemptTimeline } from "./loop/AttemptTimeline.js";
import { LoopGraph } from "./loop/LoopGraph.js";
import { deriveLoopState, type StageId } from "./loop/useCaseLoopState.js";
import { useLiveRun } from "./loop/useLiveRun.js";
import { ActivityStream } from "./loop/ActivityStream.js";
import { deriveActivities, type RawEvent } from "./loop/activities.js";
import { rupees } from "./ui/format.js";
import { TopBar } from "./room/TopBar.js";
import { Sidebar } from "./room/Sidebar.js";
import { CustomerPanel } from "./room/CustomerPanel.js";
import { RazorpayCheckout } from "./room/RazorpayCheckout.js";
import { useRoomStream } from "./room/useRoomStream.js";
import { RESOLVED_LANES, type CaseDetail, type Lane, type RecoveryCase, type RunSummary } from "./types.js";
import type { RuntimeConfig } from "./api.js";
import {
  caseDetail,
  listCases,
  queue,
  recover,
  runtimeConfig,
  scoreboard,
  simulateCapture,
  stopCase,
  verifyAudit,
} from "./api.js";
import type { AuditVerify } from "./api.js";
import { Play, User, ArrowRight, Check, X, Square, Workflow } from "./ui/icons.js";
import { Spinner } from "./ui/motion.js";
import { Modal } from "./ui/Modal.js";
import { Drawer } from "./ui/Drawer.js";



export function App() {
  const [cases, setCases] = useState<RecoveryCase[]>([]);
  const [escalations, setEscalations] = useState<RecoveryCase[]>([]);
  const [board, setBoard] = useState<{ agent?: RunSummary; fixed?: RunSummary; rules?: RunSummary }>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const room = useRoomStream();

  const describeError = (err: unknown) => (err instanceof Error ? err.message : "request failed");

  useEffect(() => {
    runtimeConfig()
      .then(setCfg)
      .catch((err) => console.warn("runtimeConfig failed, falling back to hardcoded limits:", err));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [all, esc, sb] = await Promise.all([listCases(), queue(), scoreboard().catch(() => ({}))]);
      setCases(all);
      setEscalations(esc);
      setBoard(sb);
      setError(null);
    } catch (err) {
      // Keep the last-known lanes on screen rather than clearing them on a transient blip.
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  // The room stream is the primary driver of "live": any durable event anywhere refetches the
  // case lists immediately, rather than waiting up to 2s for the poll. The poll stays as a
  // fallback in case the stream drops.
  useEffect(() => {
    if (room.version > 0) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.version]);

  const recoverGuarded = useCallback(async (id: string) => {
    try {
      await recover(id);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  const simulateCaptureGuarded = useCallback(async (id: string) => {
    try {
      await simulateCapture(id);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  const stopCaseGuarded = useCallback(async (id: string) => {
    try {
      await stopCase(id);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  const freshCase = cases.find((c) => c.lane === "INCOMING");
  const watchLive = useCallback(async () => {
    if (!freshCase) return;
    setSelected(freshCase.id);
    await recoverGuarded(freshCase.id);
  }, [freshCase, recoverGuarded]);

  return (
    <div className="room" data-surface="room">
      <TopBar metrics={room.metrics} board={board} onError={setError} />

      {error && (
        <div className="banner banner--error" role="alert">
          <span>{error}</span>
          <button className="banner__dismiss" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <Sidebar
        connected={room.connected}
        braked={room.metrics?.braked ?? false}
        cases={cases}
        escalations={escalations}
        selected={selected}
        onSelect={setSelected}
        freshCase={freshCase}
        onWatchLive={watchLive}
        onEscalationDone={refresh}
        onError={setError}
      />

      <Stage
        caseId={selected}
        freshCase={freshCase?.id ?? null}
        cfg={cfg}
        onRecover={recoverGuarded}
        onSimulateCapture={simulateCaptureGuarded}
        onStop={stopCaseGuarded}
      />
    </div>
  );
}

const DEFAULT_LIMITS = { maxAttempts: 4, maxExposurePaise: 500000, cooldownHours: 6 };
const STAGE_LABEL: Record<StageId, string> = {
  INCOMING: "queued",
  INVESTIGATE: "investigating",
  PROPOSE: "proposing",
  GATE: "at the safety gate",
  EXECUTE: "executing",
  OUTCOME: "wrapping up",
};

function toRaw(events: CaseDetail["events"]): RawEvent[] {
  return events.map((e) => ({ type: e.type, payload: e.payload, at: e.createdAt }));
}
function liveToRaw(audit: ReturnType<typeof useLiveRun>["audit"]): RawEvent[] {
  return audit.map((e) => ({ type: e.eventType, payload: e.payload, at: e.at }));
}

function Stage({
  caseId,
  freshCase,
  cfg,
  onRecover,
  onSimulateCapture,
  onStop,
}: {
  caseId: string | null;
  freshCase: string | null;
  cfg: RuntimeConfig | null;
  onRecover: (id: string) => Promise<void>;
  onSimulateCapture: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [showCustomer, setShowCustomer] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const run = useLiveRun(caseId);
  const limits = cfg?.limits ?? DEFAULT_LIMITS;

  useEffect(() => {
    setShowCustomer(false);
    setShowGraph(false);
    setConfirmingStop(false);
  }, [caseId]);

  useEffect(() => {
    if (!caseId) {
      setDetail(null);
      return;
    }
    const load = () => caseDetail(caseId).then(setDetail).catch(() => undefined);
    load();
    const poll = setInterval(load, 1500);
    return () => clearInterval(poll);
  }, [caseId]);

  useEffect(() => {
    if (!run.live || !run.startedAt) {
      setElapsedMs(0);
      return;
    }
    const startedAt = run.startedAt;
    const update = () => setElapsedMs(Date.now() - startedAt);
    update();
    const t = setInterval(update, 400);
    return () => clearInterval(t);
  }, [run.live, run.startedAt]);

  if (!caseId) {
    return (
      <section className="stage stage--empty">
        <p className="empty">
          Pick a case on the left to watch how the agent worked it — the signals it pulled, what
          it concluded, how the safety gate ruled, and what actually happened.
          {freshCase && (
            <>
              <br />
              <button className="btn btn--primary" onClick={() => onRecover(freshCase)}>
                <Play size={13} /> Watch a live recovery
              </button>
            </>
          )}
        </p>
      </section>
    );
  }

  const kase = detail?.case;
  const events = detail?.events ?? [];
  const attempt = detail?.attempts.at(-1);

  const loopState = deriveLoopState(events, {
    running: run.live,
    reasoning: run.reasoning,
    tools: run.tools,
    toolResultCount: run.toolResults.length,
    proposalKind: run.proposal?.action ?? null,
    degraded: run.proposal?.degraded ?? false,
    doneLane: run.doneLane,
  });

  const fromEvents = toRaw(events);
  const fromLive = liveToRaw(run.audit);
  const rawEvents = fromLive.length > fromEvents.length ? fromLive : fromEvents;
  const activities = deriveActivities(rawEvents);
  const liveStepStatus = run.live
    ? { step: run.tools.length + (run.proposal ? 1 : 0), budget: cfg?.stepBudget ?? 6, elapsedMs }
    : null;

  const canStop = kase && !RESOLVED_LANES.includes(kase.lane);

  return (
    <section className="stage">
      <div className="stage__topbar">
        <div className="stage__id">
          <span className="case__kicker">Customer</span>
          <span className="case__cust">
            {run.live && <span className="dot" />}
            {kase?.customerRef ?? "…"}
          </span>
          {kase && (
            <span className="case__facts">
              <span className="case__fact">
                <span className="case__fact-v">{rupees(kase.amountPaise)}</span> at risk
              </span>
              <span className="case__fact">{kase.failureReason.replace(/_/g, " ")}</span>
              <span className="case__fact">{kase.instrument?.issuer ?? kase.method ?? "card"}</span>
              <span className="case__fact">
                {kase.customerHistory.filter((h) => h.status === "captured").length}/
                {kase.customerHistory.length} clean payments
              </span>
            </span>
          )}
        </div>
        {kase && (
          <div className="fence">
            <span className="fence__cell">
              <span className="fence__k">Attempt</span>
              <span className="fence__v">
                {attempt?.attemptNo ?? 0} / {limits.maxAttempts}
              </span>
            </span>
            <span className="fence__cell">
              <span className="fence__k">Exposure</span>
              <span className={"fence__v" + (kase.amountPaise > limits.maxExposurePaise ? " fence--over" : "")}>
                {rupees(kase.amountPaise)} of {rupees(limits.maxExposurePaise)}
              </span>
            </span>
            <span className="fence__cell">
              <span className="fence__k">Cooldown</span>
              <span className="fence__v">{limits.cooldownHours}h</span>
            </span>
            <span className="fence__cell">
              <span className="fence__k">Lane</span>
              <span className="stage__lane">{kase.lane.replace(/_/g, " ")}</span>
            </span>
          </div>
        )}
        <div className="stage__actions">
          {kase && (
            <button className="btn btn--ghost" onClick={() => setShowCustomer(true)}>
              <User size={13} /> Customer
            </button>
          )}
          {kase?.lane === "INCOMING" && (
            <button className="btn btn--primary" onClick={() => onRecover(caseId)}>
              Work this case now
            </button>
          )}
          {kase?.lane === "ATTEMPTING" && attempt?.status === "PENDING" && attempt.razorpayRef && cfg && (
            <RazorpayCheckout
              caseId={caseId}
              keyId={cfg.razorpayKeyId}
              customerRef={kase.customerRef}
              onPaid={() => caseDetail(caseId).then(setDetail).catch(() => undefined)}
            />
          )}
          {kase?.lane === "ATTEMPTING" && attempt?.status === "PENDING" && attempt.razorpayRef && (
            <button className="btn btn--ghost" onClick={() => onSimulateCapture(caseId)}>
              Simulate payment (no real charge) <ArrowRight size={13} />
            </button>
          )}
          {canStop && confirmingStop && (
            <span className="topbar__confirm-stop">
              <span>Stop permanently — cannot be resumed.</span>
              <button
                className="btn btn--danger-solid"
                onClick={() => {
                  setConfirmingStop(false);
                  onStop(caseId);
                }}
              >
                <Square size={13} /> Confirm
              </button>
              <button className="btn btn--ghost" onClick={() => setConfirmingStop(false)} aria-label="Cancel">
                <X size={13} />
              </button>
            </span>
          )}
          {canStop && !confirmingStop && (
            <button className="btn btn--stop" onClick={() => setConfirmingStop(true)}>
              <Square size={13} /> Stop this case
            </button>
          )}
          <VerifyAuditButton caseId={caseId} />
        </div>
      </div>

      {kase && (
        <Drawer
          open={showCustomer}
          onClose={() => setShowCustomer(false)}
          title={
            <>
              Customer <span className="mono">{kase.customerRef}</span>
            </>
          }
        >
          <CustomerPanel kase={kase} />
        </Drawer>
      )}

      <div className="stage__body">
        <div className="stage__stream">
          <ActivityStream activities={activities} liveNarration={loopState.reasoningHead} liveStepStatus={liveStepStatus} />
        </div>

        <div className="stage__graph-toggle">
          <button
            className={"btn btn--ghost" + (showGraph ? " btn--on" : "")}
            onClick={() => setShowGraph((v) => !v)}
          >
            <Workflow size={13} /> Execution graph
          </button>
          {run.live && !showGraph && (
            <span className="stage__graph-hint">
              {STAGE_LABEL[(Object.entries(loopState.stages).find(([, st]) => st === "active")?.[0] ?? "INVESTIGATE") as StageId]}
            </span>
          )}
        </div>
      </div>

      <Modal open={showGraph} onClose={() => setShowGraph(false)} title="Execution graph">
        <LoopGraph state={loopState} />
      </Modal>

      <div className="stage__timeline">
        <AttemptTimeline attempts={detail?.attempts ?? []} />
      </div>
    </section>
  );
}

// Proves the append-only guarantee rather than just claiming it: connects as the app DB role and
// tries to UPDATE recovery_events, expecting the database itself to refuse.
function VerifyAuditButton({ caseId }: { caseId: string }) {
  const [result, setResult] = useState<AuditVerify | "pending" | null>(null);
  const run = async () => {
    setResult("pending");
    try {
      setResult(await verifyAudit(caseId));
    } catch {
      setResult(null);
    }
  };
  return (
    <span className="verify-audit">
      <button
        className="btn btn--ghost"
        onClick={run}
        disabled={result === "pending"}
        title="Connects to Postgres as the app's own restricted role and tries to UPDATE the event log. The database refuses: the role has SELECT and INSERT only, no UPDATE or DELETE."
      >
        {result === "pending" ? <Spinner size={13} /> : null}
        {result === "pending" ? "Checking…" : "Check audit log permissions"}
      </button>
      {result && result !== "pending" && (
        <span className={"verify-audit__result" + (result.enforced ? " verify-audit__result--ok" : " verify-audit__result--bad")}>
          {result.enforced ? <Check size={13} /> : <X size={13} />}
          {result.enforced ? "App role denied: SELECT and INSERT only, no UPDATE or DELETE" : result.error ?? "not enforced"}
        </span>
      )}
    </span>
  );
}
