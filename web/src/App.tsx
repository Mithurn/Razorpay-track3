import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles/room.css";
import "./loop/loop.css";
import { AttemptTimeline } from "./loop/AttemptTimeline.js";
import { LoopGraph } from "./loop/LoopGraph.js";
import { deriveLoopState, type StageId } from "./loop/useCaseLoopState.js";
import { useLiveRun } from "./loop/useLiveRun.js";
import { Commentary } from "./loop/Commentary.js";
import { ConclusionCard, type Conclusion } from "./loop/ConclusionCard.js";
import { AuditTrail } from "./loop/AuditTrail.js";
import type { AuditRow } from "./loop/auditText.js";
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
  verifyAudit,
} from "./api.js";

const LANE_ORDER: Lane[] = [
  "INCOMING",
  "DIAGNOSING",
  "DECIDING",
  "ATTEMPTING",
  "RETRY_SCHEDULED",
  "RECOVERED",
  "ESCALATED",
  "WRITTEN_OFF",
];

const rupees = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function App() {
  const [cases, setCases] = useState<RecoveryCase[]>([]);
  const [escalations, setEscalations] = useState<RecoveryCase[]>([]);
  const [board, setBoard] = useState<{ agent?: RunSummary; fixed?: RunSummary }>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<"flow" | "waiting">("flow");
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const freshCase = cases.find((c) => c.lane === "INCOMING");
  const watchLive = useCallback(async () => {
    if (!freshCase) return;
    setSelected(freshCase.id);
    await recoverGuarded(freshCase.id);
  }, [freshCase, recoverGuarded]);

  return (
    <div className="room" data-surface="room">
      <header className="room__header">
        <span className="brand__name">Recovery Room</span>
        <Scoreboard board={board} liveCases={cases} />
      </header>

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
                          (c.lane === "ESCALATED" ? " card--escalated" : "")
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
      />
    </div>
  );
}

function Scoreboard({ board, liveCases }: { board: { agent?: RunSummary; fixed?: RunSummary }; liveCases: RecoveryCase[] }) {
  const liveRecovered = liveCases.filter((c) => c.lane === "RECOVERED").reduce((s, c) => s + c.recoveredPaise, 0);
  const liveCount = liveCases.filter((c) => c.lane === "RECOVERED").length;
  const a = board.agent;
  const f = board.fixed;

  if (!a || !f) {
    return (
      <div className="board">
        <div className="board__col board__col--agent">
          <span className="board__arm">recovered · this room</span>
          <span className="board__money">{rupees(liveRecovered)}</span>
          <span className="board__meta">
            {liveCount > 0 ? `${liveCount} case${liveCount === 1 ? "" : "s"} recovered live` : "run the batch for the agent-vs-fixed number"}
          </span>
        </div>
      </div>
    );
  }

  const delta = a.recoveredPaise - f.recoveredPaise;
  return (
    <div className="board">
      <div className="board__col board__col--agent">
        <span className="board__arm">recovered · this room</span>
        <span className="board__money">{rupees(liveRecovered)}</span>
        <span className="board__meta">
          {liveCount} case{liveCount === 1 ? "" : "s"} recovered live · agent beat fixed by {rupees(Math.max(delta, 0))} in the batch
        </span>
      </div>
      <div className="board__col board__col--fixed">
        <span className="board__arm">agent vs fixed · batch of {a.cases}</span>
        <span className="board__money">
          {rupees(a.recoveredPaise)} <span className="board__vs">vs</span> {rupees(f.recoveredPaise)}
        </span>
        <span className="board__meta">
          {pct(a.recoveryRate)} vs {pct(f.recoveryRate)} recovered · {pct(a.escalationRate)} vs {pct(f.escalationRate)} escalated
        </span>
      </div>
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

function Stage({
  caseId,
  freshCase,
  cfg,
  onRecover,
  onSimulateCapture,
}: {
  caseId: string | null;
  freshCase: string | null;
  cfg: RuntimeConfig | null;
  onRecover: (id: string) => Promise<void>;
  onSimulateCapture: (id: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [tick, setTick] = useState(0);
  const run = useLiveRun(caseId);
  const limits = cfg?.limits ?? DEFAULT_LIMITS;

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
  const proposedEvent = [...events].reverse().find((e) => e.type === "AGENT_PROPOSED" || e.type === "AGENT_DEGRADED");
  const attempt = detail?.attempts.at(-1);

  const loopState = deriveLoopState(events, {
    open: run.open,
    reasoning: run.reasoning,
    tools: run.tools,
    toolResultCount: run.toolResults.length,
    proposalKind: run.proposal?.action ?? null,
    degraded: run.proposal?.degraded ?? false,
    doneLane: run.doneLane,
  });

  const conclusion = deriveConclusion(run.proposal, proposedEvent);
  const elapsedMs = runElapsedMs(run, events);
  const auditRows = mergeAudit(events, run.audit);
  const activeStage = (Object.entries(loopState.stages).find(([, st]) => st === "active")?.[0] ?? "INVESTIGATE") as StageId;

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
      </div>

      <div className="stage__body">
        <div className="stage__graph">
          <LoopGraph state={loopState} />
        </div>

        <div className="stage__side">
          {(run.commentary.length > 0 || run.live) && (
            <Commentary
              lines={run.commentary}
              status={
                run.live
                  ? {
                      stage: STAGE_LABEL[activeStage],
                      step: run.tools.length + (run.proposal ? 1 : 0),
                      budget: cfg?.stepBudget ?? 6,
                      toolCalls: run.tools.length,
                      elapsedMs: run.startedAt ? Date.now() - run.startedAt : 0,
                    }
                  : null
              }
            />
          )}

          {conclusion && (
            <ConclusionCard
              conclusion={conclusion}
              model={cfg?.model ?? "agent"}
              elapsedMs={elapsedMs}
              deadlineMs={cfg?.deadlineMs ?? 90_000}
            />
          )}

          <AuditTrail rows={auditRows} limits={limits} onVerify={() => verifyAudit(caseId)} />
        </div>
      </div>

      <div className="stage__timeline">
        <AttemptTimeline attempts={detail?.attempts ?? []} />
      </div>
    </section>
  );
}

function deriveConclusion(
  live: ReturnType<typeof useLiveRun>["proposal"],
  stored: CaseDetail["events"][number] | undefined,
): Conclusion | null {
  if (live) {
    return {
      rootCause: live.rootCause,
      action: live.action,
      confidence: live.confidence,
      reasoning: live.reasoning,
      toolCalls: live.toolCalls,
      degraded: live.degraded,
    };
  }
  if (!stored) return null;
  const p = stored.payload as {
    rootCause?: string | null;
    action?: { kind?: string };
    confidence?: number;
    reasoning?: string;
    toolCalls?: number;
  };
  return {
    rootCause: p.rootCause ?? null,
    action: p.action?.kind ?? "?",
    confidence: p.confidence ?? 0,
    reasoning: p.reasoning ?? "",
    toolCalls: p.toolCalls ?? 0,
    degraded: stored.type === "AGENT_DEGRADED",
  };
}

function runElapsedMs(run: ReturnType<typeof useLiveRun>, events: CaseDetail["events"]): number | null {
  if (run.startedAt && run.concludedAt) return run.concludedAt - run.startedAt;
  const started = [...events].reverse().find((e) => e.type === "INVESTIGATION_STARTED");
  const proposed = [...events].reverse().find((e) => e.type === "AGENT_PROPOSED" || e.type === "AGENT_DEGRADED");
  if (started && proposed) return Date.parse(proposed.createdAt) - Date.parse(started.createdAt);
  return null;
}

function mergeAudit(events: CaseDetail["events"], live: ReturnType<typeof useLiveRun>["audit"]): AuditRow[] {
  const fromEvents: AuditRow[] = events.map((e) => ({ eventType: e.type, payload: e.payload, at: e.createdAt }));
  const fromLive: AuditRow[] = live.map((e) => ({ eventType: e.eventType, payload: e.payload, at: e.at }));
  return fromLive.length > fromEvents.length ? fromLive : fromEvents;
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
