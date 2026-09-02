import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles/room.css";
import "./loop/loop.css";
import { AttemptTimeline } from "./loop/AttemptTimeline.js";
import { LoopGraph } from "./loop/LoopGraph.js";
import { deriveLoopState } from "./loop/useCaseLoopState.js";
import type { CaseDetail, Lane, RecoveryCase, RunSummary, StreamEvent } from "./types.js";
import { caseDetail, decide, listCases, queue, recover, scoreboard, simulateCapture, streamCase } from "./api.js";

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

  const refresh = useCallback(async () => {
    const [all, esc, sb] = await Promise.all([listCases(), queue(), scoreboard().catch(() => ({}))]);
    setCases(all);
    setEscalations(esc);
    setBoard(sb);
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

  const freshCase = cases.find((c) => c.lane === "INCOMING");
  const watchLive = useCallback(async () => {
    if (!freshCase) return;
    setSelected(freshCase.id);
    await recover(freshCase.id);
  }, [freshCase]);

  return (
    <div className="room" data-surface="room">
      <header className="room__header">
        <div className="brand">
          <span className="brand__name">Recovery Room</span>
          <span className="brand__sub">a bounded agent working a queue of failed payments</span>
          {freshCase && (
            <button className="btn btn--primary brand__watch" onClick={watchLive}>
              ▶ watch a live recovery
            </button>
          )}
        </div>
        <Scoreboard board={board} liveCases={cases} />
      </header>

      <section className="panel">
        <div className="panel__label">
          <span>Case flow</span>
          <span>{cases.length}</span>
        </div>
        {LANE_ORDER.map((lane) => {
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
        })}
      </section>

      <CasePane caseId={selected} onRecover={recover} onSimulateCapture={simulateCapture} />

      <section className="panel">
        <div className="panel__label">
          <span>Waiting on you</span>
          <span>{escalations.length}</span>
        </div>
        {escalations.length === 0 ? (
          <p className="empty">
            Nothing needs a human right now. When the agent hits a risk hold, or genuinely can't
            tell what to do, the case takes a seat here.
          </p>
        ) : (
          escalations.map((c) => (
            <EscalationRow key={c.id} kase={c} onDone={refresh} onOpen={() => setSelected(c.id)} />
          ))
        )}
      </section>
    </div>
  );
}

function Scoreboard({ board, liveCases }: { board: { agent?: RunSummary; fixed?: RunSummary }; liveCases: RecoveryCase[] }) {
  const liveRecovered = liveCases.filter((c) => c.lane === "RECOVERED").reduce((s, c) => s + c.recoveredPaise, 0);
  const a = board.agent;
  const f = board.fixed;

  if (!a || !f) {
    return (
      <div className="board">
        <div className="board__col board__col--agent">
          <span className="board__arm">recovered · this room</span>
          <span className="board__money">{rupees(liveRecovered)}</span>
          <span className="board__meta">run the batch for the agent-vs-fixed number</span>
        </div>
      </div>
    );
  }

  const delta = a.recoveredPaise - f.recoveredPaise;
  return (
    <div className="board">
      <div className="board__col board__col--agent">
        <span className="board__arm">agent · batch of {a.cases}</span>
        <span className="board__money">{rupees(a.recoveredPaise)}</span>
        <span className="board__meta">
          {pct(a.recoveryRate)} recovered · {pct(a.escalationRate)} to a human · {a.meanAttemptsPerRecovery.toFixed(1)} tries
        </span>
      </div>
      <div className="board__col board__col--fixed">
        <span className="board__arm">fixed schedule · day 1/3/5/7</span>
        <span className="board__money">{rupees(f.recoveredPaise)}</span>
        <span className="board__meta">
          {pct(f.recoveryRate)} recovered · {pct(f.escalationRate)} to a human
        </span>
      </div>
      <span className="board__delta">+{rupees(delta)} recovered</span>
    </div>
  );
}

function CasePane({
  caseId,
  onRecover,
  onSimulateCapture,
}: {
  caseId: string | null;
  onRecover: (id: string) => Promise<void>;
  onSimulateCapture: (id: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [reasoning, setReasoning] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [findings, setFindings] = useState<string[]>([]);
  const [liveProposal, setLiveProposal] = useState<{ action: string; degraded: boolean } | null>(null);
  const [doneLane, setDoneLane] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!caseId) {
      setDetail(null);
      return;
    }
    setReasoning("");
    setTools([]);
    setFindings([]);
    setLiveProposal(null);
    setDoneLane(null);
    seq.current += 1;
    const controller = new AbortController();
    const load = () => caseDetail(caseId).then(setDetail).catch(() => undefined);
    load();

    (async () => {
      try {
        for await (const ev of streamCase(caseId, controller.signal))
          applyStream(ev, { setReasoning, setTools, setFindings, setLiveProposal, setDoneLane, setLive });
      } catch {
        /* aborted */
      }
    })();

    const poll = setInterval(load, 1500);
    return () => {
      controller.abort();
      clearInterval(poll);
    };
  }, [caseId]);

  if (!caseId) {
    return (
      <section className="panel">
        <div className="panel__label">
          <span>Live case</span>
        </div>
        <p className="empty">
          Pick a card to watch how the agent worked it — the signals it pulled, what it concluded,
          how the safety gate ruled, and what actually happened.
        </p>
      </section>
    );
  }

  const kase = detail?.case;
  const events = detail?.events ?? [];
  const proposal = events.find((e) => e.type === "AGENT_PROPOSED" || e.type === "AGENT_DEGRADED");
  const gate = events.find((e) => e.type === "GATE_APPLIED");
  const attempt = detail?.attempts.at(-1);
  const reasoningText = reasoning || String((proposal?.payload as { reasoning?: string })?.reasoning ?? "");
  const loopState = deriveLoopState(events, {
    open: live,
    reasoning,
    tools,
    findings,
    proposalKind: liveProposal?.action ?? null,
    degraded: liveProposal?.degraded ?? false,
    doneLane,
  });

  return (
    <section className="panel">
      <div className="panel__label">
        <span>{live && <span className="dot" />}Live case</span>
        <span>{kase?.lane.replace(/_/g, " ")}</span>
      </div>

      {kase && (
        <div className="case__head">
          <span className="case__cust">{kase.customerRef}</span>
          <span className="case__facts">
            {rupees(kase.amountPaise)} · {kase.failureReason} ·{" "}
            {kase.instrument?.issuer ?? kase.method ?? "card"} ·{" "}
            {kase.customerHistory.filter((h) => h.status === "captured").length}/{kase.customerHistory.length} clean payments
          </span>
        </div>
      )}

      {kase && (
        <div className="fence">
          <span>attempt {attempt?.attemptNo ?? 0}/4</span>
          <span className={kase.amountPaise > 500000 ? "fence--over" : ""}>
            exposure {rupees(kase.amountPaise)} / ₹5,000 cap
          </span>
          <span>cooldown 6h</span>
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

      <LoopGraph state={loopState} />

      {findings.length > 0 && (
        <div className="findings">
          {findings.map((f, i) => (
            <div className="findings__row" key={i}>
              <span className="findings__dot" />
              {f}
            </div>
          ))}
        </div>
      )}

      {reasoningText && (
        <div className="stream">
          <Fading text={reasoningText} seq={seq.current} />
        </div>
      )}

      {proposal && (
        <div className="verdict">
          <div className="verdict__line">
            <span className="verdict__k">root cause</span>
            <span className="verdict__v">
              {String((proposal.payload as { rootCause?: string }).rootCause ?? "undiagnosed")}
              {proposal.type === "AGENT_DEGRADED" ? " · degraded to safe fallback" : ""}
            </span>
          </div>
          <div className="verdict__line">
            <span className="verdict__k">proposed</span>
            <span className="verdict__v verdict__v--action">
              {String((proposal.payload as { action?: { kind?: string } }).action?.kind ?? "")}
            </span>
          </div>
        </div>
      )}

      {gate && (() => {
        const g = gate.payload as { outcome?: string; proposed?: string; applied?: string; reason?: string };
        const clamped = g.outcome === "clamp" || g.outcome === "skip";
        return (
          <div className="verdict">
            <div className="verdict__line">
              <span className="verdict__k">safety gate</span>
              <span className="verdict__v">
                {clamped ? (
                  <>
                    proposed <span className="verdict__v--action">{g.proposed}</span> →{" "}
                    <span className="verdict__v--deny">
                      {g.outcome === "skip" ? "SKIP" : `clamped to ${g.applied}`}
                    </span>
                    {g.reason ? ` · ${g.reason}` : ""}
                  </>
                ) : (
                  <>
                    passed <span className="verdict__v--action">{g.applied}</span> unchanged
                  </>
                )}
              </span>
            </div>
            <div className="verdict__line">
              <span className="verdict__k" />
              <span className="verdict__note">deterministic · pure function · can only add caution, never remove it</span>
            </div>
          </div>
        );
      })()}

      <AttemptTimeline attempts={detail?.attempts ?? []} />
      {attempt && (
        <div className="verdict">
          <div className="verdict__line">
            <span className="verdict__k" />
            <span className="verdict__note">
              exactly-once · one key = one order · a 5xx re-checks GET /payments/:id before concluding
            </span>
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="audit">
          <div className="audit__head">audit trail · append-only, enforced by database grant</div>
          {events.map((e) => (
            <div className="audit__row" key={e.id}>
              <span className="audit__t">{new Date(e.createdAt).toLocaleTimeString()}</span>
              <span>{e.type}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Fading({ text, seq }: { text: string; seq: number }) {
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((w, i) =>
        /^\s+$/.test(w) ? (
          w
        ) : (
          <span key={`${seq}-${i}`} className="sk-word">
            {w}
          </span>
        ),
      )}
    </>
  );
}

function EscalationRow({ kase, onDone, onOpen }: { kase: RecoveryCase; onDone: () => void; onOpen: () => void }) {
  const act = async (decision: "approve" | "redirect" | "write_off", redirectTo?: string) => {
    await decide(kase.id, { decision, redirectTo });
    onDone();
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

function applyStream(
  ev: StreamEvent,
  s: {
    setReasoning: React.Dispatch<React.SetStateAction<string>>;
    setTools: React.Dispatch<React.SetStateAction<string[]>>;
    setFindings: React.Dispatch<React.SetStateAction<string[]>>;
    setLiveProposal: React.Dispatch<React.SetStateAction<{ action: string; degraded: boolean } | null>>;
    setDoneLane: React.Dispatch<React.SetStateAction<string | null>>;
    setLive: React.Dispatch<React.SetStateAction<boolean>>;
  },
): void {
  if (ev.type === "reasoning") s.setReasoning((r) => r + ev.text);
  else if (ev.type === "tool") s.setTools((t) => (t.includes(ev.name) ? t : [...t, ev.name]));
  else if (ev.type === "finding") s.setFindings((f) => (f.includes(ev.text) ? f : [...f, ev.text]));
  else if (ev.type === "proposal") s.setLiveProposal({ action: ev.action, degraded: ev.degraded });
  else if (ev.type === "open") s.setLive(true);
  else if (ev.type === "done") {
    s.setLive(false);
    s.setDoneLane(ev.lane);
  }
}
