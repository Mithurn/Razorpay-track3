import { useCallback, useEffect, useMemo, useState } from "react";
import "./styles/room.css";
import "./loop/loop.css";
import "./room/room-extra.css";
import { AttemptTimeline } from "./loop/AttemptTimeline.js";
import { LoopGraph } from "./loop/LoopGraph.js";
import { deriveLoopState, type StageId } from "./loop/useCaseLoopState.js";
import { useLiveRun } from "./loop/useLiveRun.js";
import { ActivityStream } from "./loop/ActivityStream.js";
import { deriveActivities, type RawEvent } from "./loop/activities.js";
import { TopBar } from "./room/TopBar.js";
import { CustomerPanel } from "./room/CustomerPanel.js";
import { useRoomStream } from "./room/useRoomStream.js";
import type { CaseDetail, Lane, RecoveryCase, RunSummary } from "./types.js";
import type { RuntimeConfig } from "./api.js";
import {
  caseDetail,
  decide,
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

const TERMINAL: Lane[] = ["RECOVERED", "ESCALATED", "WRITTEN_OFF", "STOPPED"];

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

export function App() {
  const [cases, setCases] = useState<RecoveryCase[]>([]);
  const [escalations, setEscalations] = useState<RecoveryCase[]>([]);
  const [board, setBoard] = useState<{ agent?: RunSummary; fixed?: RunSummary }>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"flow" | "waiting">("flow");
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

  const byLane = useMemo(() => {
    const map = new Map<Lane, RecoveryCase[]>();
    for (const l of LANE_ORDER) map.set(l, []);
    for (const c of cases) map.get(c.lane)?.push(c);
    return map;
  }, [cases]);

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
      <TopBar metrics={room.metrics} connected={room.connected} board={board} onError={setError} />

      {error && (
        <div className="banner banner--error" role="alert">
          <span>{error}</span>
          <button className="banner__dismiss" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      <aside className="sidebar">
        <div className="sidebar__tabs">
          <button
            className={"sidebar__tab" + (tab === "flow" ? " sidebar__tab--active" : "")}
            onClick={() => setTab("flow")}
          >
            Case flow <span className="sidebar__count">{cases.length}</span>
          </button>
          <button
            className={"sidebar__tab" + (tab === "waiting" ? " sidebar__tab--active" : "")}
            onClick={() => setTab("waiting")}
          >
            Waiting on you
            {escalations.length > 0 && <span className="sidebar__badge">{escalations.length}</span>}
          </button>
        </div>

        {freshCase && (
          <button className="btn btn--primary sidebar__watch" onClick={watchLive}>
            ▶ watch a live recovery
          </button>
        )}

        <div className="sidebar__body">
          {tab === "flow"
            ? LANE_ORDER.map((lane) => {
                const list = byLane.get(lane) ?? [];
                if (list.length === 0) return null;
                return (
                  <div className="lane" key={lane}>
                    <div className="lane__head">
                      <span>{lane.replace(/_/g, " ")}</span>
                      <span className="lane__count">{list.length}</span>
                    </div>
                    {list.slice(0, 12).map((c) => (
                      <div
                        key={c.id}
                        className={
                          "card" +
                          (selected === c.id ? " card--active" : "") +
                          (c.lane === "RECOVERED" ? " card--recovered" : "") +
                          (c.lane === "ESCALATED" || c.lane === "STOPPED" ? " card--escalated" : "")
                        }
                        onClick={() => setSelected(c.id)}
                      >
                        <div className="card__row">
                          <span className="card__cust">{c.customerRef}</span>
                          <span className="card__amount">
                            {c.lane === "RECOVERED" ? rupees(c.recoveredPaise) : rupees(c.amountPaise)}
                          </span>
                        </div>
                        <span className="card__reason">
                          {c.failureReason}
                          {c.instrument?.issuer ? ` · ${c.instrument.issuer}` : ""}
                        </span>
                      </div>
                    ))}
                    {list.length > 12 && <span className="card__reason">+{list.length - 12} more</span>}
                  </div>
                );
              })
            : escalations.length === 0
              ? (
                <p className="empty">
                  Nothing needs a human right now. When the agent hits a risk hold, or genuinely
                  can't tell what to do, the case takes a seat here.
                </p>
              )
              : escalations.map((c) => (
                  <EscalationRow
                    key={c.id}
                    kase={c}
                    onDone={refresh}
                    onOpen={() => setSelected(c.id)}
                    onError={setError}
                  />
                ))}
        </div>
      </aside>

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
  const [tick, setTick] = useState(0);
  const run = useLiveRun(caseId);
  const limits = cfg?.limits ?? DEFAULT_LIMITS;

  useEffect(() => {
    setShowCustomer(false);
    setShowGraph(false);
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
    if (!run.live) return;
    const t = setInterval(() => setTick((n) => n + 1), 400);
    return () => clearInterval(t);
  }, [run.live]);
  void tick;

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
                ▶ watch a live recovery
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
    ? { step: run.tools.length + (run.proposal ? 1 : 0), budget: cfg?.stepBudget ?? 6, elapsedMs: run.startedAt ? Date.now() - run.startedAt : 0 }
    : null;

  const canStop = kase && !TERMINAL.includes(kase.lane);

  return (
    <section className="stage">
      <div className="stage__topbar">
        <div className="stage__id">
          <span className="case__cust">
            {run.live && <span className="dot" />}
            {kase?.customerRef ?? "…"}
          </span>
          <span className="case__facts">
            {kase && (
              <>
                {rupees(kase.amountPaise)} · {kase.failureReason} ·{" "}
                {kase.instrument?.issuer ?? kase.method ?? "card"} ·{" "}
                {kase.customerHistory.filter((h) => h.status === "captured").length}/
                {kase.customerHistory.length} clean payments
              </>
            )}
          </span>
        </div>
        {kase && (
          <div className="fence">
            <span>
              attempt {attempt?.attemptNo ?? 0}/{limits.maxAttempts}
            </span>
            <span className={kase.amountPaise > limits.maxExposurePaise ? "fence--over" : ""}>
              exposure {rupees(kase.amountPaise)} / {rupees(limits.maxExposurePaise)} cap
            </span>
            <span>cooldown {limits.cooldownHours}h</span>
            <span className="stage__lane">{kase.lane.replace(/_/g, " ")}</span>
          </div>
        )}
        <div className="stage__actions">
          {kase && (
            <button className="btn btn--ghost" onClick={() => setShowCustomer((v) => !v)}>
              customer {showCustomer ? "▴" : "▾"}
            </button>
          )}
          {kase?.lane === "INCOMING" && (
            <button className="btn btn--primary" onClick={() => onRecover(caseId)}>
              work this case now
            </button>
          )}
          {kase?.lane === "ATTEMPTING" && attempt?.status === "PENDING" && attempt.razorpayRef && (
            <button className="btn btn--primary" onClick={() => onSimulateCapture(caseId)}>
              customer completes payment →
            </button>
          )}
          {canStop && (
            <button className="btn btn--stop" onClick={() => onStop(caseId)}>
              stop this case
            </button>
          )}
          <VerifyAuditButton caseId={caseId} />
        </div>
      </div>

      {showCustomer && kase && <CustomerPanel kase={kase} />}

      <div className="stage__body">
        <div className="stage__stream">
          <ActivityStream activities={activities} liveNarration={loopState.reasoningHead} liveStepStatus={liveStepStatus} />
        </div>

        <div className="stage__graph-toggle">
          <button className="btn btn--ghost" onClick={() => setShowGraph((v) => !v)}>
            {showGraph ? "hide" : "show"} execution graph {showGraph ? "▴" : "▾"}
          </button>
          {run.live && !showGraph && (
            <span className="stage__graph-hint">
              {STAGE_LABEL[(Object.entries(loopState.stages).find(([, st]) => st === "active")?.[0] ?? "INVESTIGATE") as StageId]}
            </span>
          )}
        </div>
        {showGraph && (
          <div className="stage__graph">
            <LoopGraph state={loopState} />
          </div>
        )}
      </div>

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
      <button className="btn btn--ghost" onClick={run} disabled={result === "pending"}>
        {result === "pending" ? "checking…" : "verify audit trail"}
      </button>
      {result && result !== "pending" && (
        <span className={"verify-audit__result" + (result.enforced ? " verify-audit__result--ok" : " verify-audit__result--bad")}>
          {result.enforced ? "✓ append-only enforced by the database" : "✗ " + (result.error ?? "not enforced")}
        </span>
      )}
    </span>
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
        <span className="card__cust">{kase.customerRef}</span>
        <span className="card__amount">{rupees(kase.amountPaise)}</span>
      </div>
      <span className="card__reason">{kase.failureReason}</span>
      <div className="rail-item__actions">
        <button className="btn btn--primary" onClick={() => act("approve")}>
          retry
        </button>
        <button className="btn" onClick={() => act("redirect", "PAYMENT_LINK")}>
          send link
        </button>
        <button className="btn" onClick={() => act("write_off")}>
          write off
        </button>
      </div>
    </div>
  );
}
