import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./styles/room.css";
import type { Attempt, CaseDetail, Lane, RecoveryCase, StreamEvent } from "./types.js";
import { caseDetail, decide, listCases, queue, recover, streamCase } from "./api.js";

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

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN")}`;

export function App() {
  const [cases, setCases] = useState<RecoveryCase[]>([]);
  const [escalations, setEscalations] = useState<RecoveryCase[]>([]);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [all, esc] = await Promise.all([listCases(), queue()]);
    setCases(all);
    setEscalations(esc);
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

  const recovered = cases.filter((c) => c.lane === "RECOVERED");
  const recoveredTotal = recovered.reduce((s, c) => s + c.recoveredPaise, 0);

  return (
    <div className="room" data-surface="room">
      <header className="room__header">
        <span className="room__title">Recovery Room</span>
        <div className="scoreboard">
          <div className="score score--agent">
            <span className="score__value">{rupees(recoveredTotal)}</span>
            <span className="score__label">recovered · live</span>
          </div>
          <div className="score score--fixed">
            <span className="score__value">
              {recovered.length}/{cases.length}
            </span>
            <span className="score__label">cases closed</span>
          </div>
        </div>
      </header>

      <section className="panel">
        <div className="panel__label">Case flow</div>
        <div className="lanes">
          {LANE_ORDER.map((lane) => {
            const list = byLane.get(lane) ?? [];
            if (list.length === 0) return null;
            return (
              <div key={lane}>
                <div className="lane__name">
                  {lane.replace("_", " ")} · {list.length}
                </div>
                {list.map((c) => (
                  <div
                    key={c.id}
                    className={`card${selected === c.id ? " card--active" : ""}`}
                    onClick={() => setSelected(c.id)}
                  >
                    <div className="card__row">
                      <span className="card__cust">{c.customerRef}</span>
                      <span className="card__amount">{rupees(c.amountPaise)}</span>
                    </div>
                    <span className="card__reason">{c.failureReason}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </section>

      <CasePane caseId={selected} onRecover={recover} />

      <section className="panel">
        <div className="panel__label">Waiting on you · {escalations.length}</div>
        {escalations.map((c) => (
          <EscalationRow key={c.id} kase={c} onDone={refresh} onOpen={() => setSelected(c.id)} />
        ))}
        {escalations.length === 0 && <span className="card__reason">nothing needs a human right now</span>}
      </section>
    </div>
  );
}

function CasePane({ caseId, onRecover }: { caseId: string | null; onRecover: (id: string) => Promise<void> }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [reasoning, setReasoning] = useState("");
  const [tools, setTools] = useState<string[]>([]);
  const [live, setLive] = useState(false);
  const wordSeq = useRef(0);

  useEffect(() => {
    if (!caseId) return;
    setReasoning("");
    setTools([]);
    const controller = new AbortController();
    caseDetail(caseId).then(setDetail).catch(() => undefined);

    (async () => {
      try {
        for await (const ev of streamCase(caseId, controller.signal)) {
          applyStreamEvent(ev, { setReasoning, setTools, setLive });
        }
      } catch {
        /* aborted */
      }
    })();

    const poll = setInterval(() => caseDetail(caseId).then(setDetail).catch(() => undefined), 1500);
    return () => {
      controller.abort();
      clearInterval(poll);
    };
  }, [caseId]);

  if (!caseId) {
    return (
      <section className="panel">
        <div className="panel__label">Live case</div>
        <span className="card__reason">select a case to watch the agent work it</span>
      </section>
    );
  }

  const kase = detail?.case;
  const proposal = detail?.events.find((e) => e.type === "AGENT_PROPOSED" || e.type === "AGENT_DEGRADED");
  const gate = detail?.events.find((e) => e.type === "GATE_APPLIED");
  const finalAttempt = detail?.attempts.at(-1);

  return (
    <section className="panel stream">
      <div>
        <div className="panel__label">
          {live && <span className="dot" />}Live case · {kase?.customerRef}
        </div>
        {kase && (
          <span className="card__reason">
            {rupees(kase.amountPaise)} · {kase.failureReason} · {kase.instrument?.issuer ?? kase.method} · {kase.lane}
          </span>
        )}
        {kase?.lane === "INCOMING" && (
          <div style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => onRecover(caseId)}>
              work this case
            </button>
          </div>
        )}
      </div>

      <div className="stream__reasoning">
        <FadingText text={reasoning} seqRef={wordSeq} />
      </div>

      <div>
        {tools.map((t, i) => (
          <span key={i} className="tool-chip">
            {t}
          </span>
        ))}
      </div>

      {proposal && (
        <div className="verdict">
          <div>
            root cause:{" "}
            <b>{String((proposal.payload as { rootCause?: string }).rootCause ?? "undiagnosed")}</b>
            {proposal.type === "AGENT_DEGRADED" && " · degraded to safe fallback"}
          </div>
          <div>
            proposed:{" "}
            <span className="verdict__action">
              {String((proposal.payload as { action?: { kind?: string } }).action?.kind ?? "")}
            </span>
          </div>
          <p style={{ color: "var(--text-faint)", marginTop: 6 }}>
            {String((proposal.payload as { reasoning?: string }).reasoning ?? "")}
          </p>
        </div>
      )}

      {gate && (
        <div className="verdict">
          gate: <b>{String((gate.payload as { outcome?: string }).outcome)}</b>
          {" → "}
          <span className="verdict__action">{String((gate.payload as { applied?: string }).applied ?? "skip")}</span>
          {(gate.payload as { reason?: string }).reason ? ` (${(gate.payload as { reason?: string }).reason})` : ""}
        </div>
      )}

      {finalAttempt && <AttemptLine attempt={finalAttempt} />}
    </section>
  );
}

function AttemptLine({ attempt }: { attempt: Attempt }) {
  return (
    <div className="verdict">
      attempt {attempt.attemptNo}: <span className="verdict__action">{attempt.action}</span> → <b>{attempt.status}</b>
      {attempt.recoveredPaise > 0 && ` · ${rupees(attempt.recoveredPaise)} captured`}
      {attempt.razorpayRef && <div className="card__reason">{attempt.razorpayRef}</div>}
    </div>
  );
}

function FadingText({ text, seqRef }: { text: string; seqRef: React.MutableRefObject<number> }) {
  const words = text.split(/(\s+)/);
  return (
    <>
      {words.map((w, i) => {
        if (/^\s+$/.test(w)) return w;
        return (
          <span key={`${i}-${seqRef.current}`} className="sk-word">
            {w}
          </span>
        );
      })}
    </>
  );
}

function EscalationRow({
  kase,
  onDone,
  onOpen,
}: {
  kase: RecoveryCase;
  onDone: () => void;
  onOpen: () => void;
}) {
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
        <button className="btn" onClick={() => act("approve")}>
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

function applyStreamEvent(
  ev: StreamEvent,
  s: {
    setReasoning: React.Dispatch<React.SetStateAction<string>>;
    setTools: React.Dispatch<React.SetStateAction<string[]>>;
    setLive: React.Dispatch<React.SetStateAction<boolean>>;
  },
): void {
  if (ev.type === "reasoning") s.setReasoning((r) => r + ev.text);
  else if (ev.type === "tool") s.setTools((t) => [...t, ev.name]);
  else if (ev.type === "open") s.setLive(true);
  else if (ev.type === "done") s.setLive(false);
}
