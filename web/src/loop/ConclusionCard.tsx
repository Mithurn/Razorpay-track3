export type Conclusion = {
  rootCause: string | null;
  action: string;
  confidence: number;
  reasoning: string;
  toolCalls: number;
  degraded: boolean;
};

function bar(confidence: number): string {
  const filled = Math.round(confidence * 10);
  return "▓".repeat(filled) + "░".repeat(10 - filled);
}

export function ConclusionCard({
  conclusion,
  model,
  elapsedMs,
  deadlineMs,
}: {
  conclusion: Conclusion;
  model: string;
  elapsedMs: number | null;
  deadlineMs: number;
}) {
  const c = conclusion;
  const modelName = model.split("/").pop() ?? model;
  const timing =
    elapsedMs != null ? `${(elapsedMs / 1000).toFixed(1)}s / ${Math.round(deadlineMs / 1000)}s deadline` : `${Math.round(deadlineMs / 1000)}s deadline`;

  return (
    <div className={"concl" + (c.degraded ? " concl--degraded" : "")}>
      {c.degraded ? (
        <div className="concl__row">
          <span className="concl__k">diagnosis</span>
          <span className="concl__v concl__v--deny">degraded to safe fallback · no diagnosis reached</span>
        </div>
      ) : (
        <div className="concl__row">
          <span className="concl__k">diagnosis</span>
          <span className="concl__v">{c.rootCause ?? "undiagnosed"}</span>
          <span className="concl__conf">
            <span className="concl__bar">{bar(c.confidence)}</span> {c.confidence.toFixed(2)}
          </span>
        </div>
      )}
      <div className="concl__row">
        <span className="concl__k">proposes</span>
        <span className="concl__v concl__v--action">{c.action}</span>
      </div>
      <div className="concl__row concl__row--why">
        <span className="concl__k">why</span>
        <span className="concl__why">{c.reasoning}</span>
      </div>
      <div className="concl__row">
        <span className="concl__k">model</span>
        <span className="concl__v concl__v--faint">
          {modelName} · {timing} · {c.toolCalls} tool call{c.toolCalls === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
