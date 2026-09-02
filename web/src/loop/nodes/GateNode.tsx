import { Handle, Position } from "@xyflow/react";
import type { LoopGate, StageStatus } from "../useCaseLoopState.js";

export type GateNodeData = { status: StageStatus; gate: LoopGate | null };

export function GateNode({ data }: { data: GateNodeData }) {
  const g = data.gate;
  return (
    <div className={`sn sn--gate sn--${data.status}`}>
      <Handle type="target" position={Position.Left} />
      <span className="sn__title">safety gate</span>
      {g ? (
        g.outcome === "allow" ? (
          <span className="sn__detail">passed {g.applied} unchanged</span>
        ) : g.outcome === "skip" ? (
          <span className="sn__detail sn__detail--deny">skipped · {g.reason}</span>
        ) : (
          <span className="sn__detail sn__detail--deny">
            {g.proposed} → clamped to {g.applied}
          </span>
        )
      ) : (
        <span className="sn__detail sn__detail--faint">deterministic · can only add caution</span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
