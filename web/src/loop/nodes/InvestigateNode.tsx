import { Handle, Position } from "@xyflow/react";
import type { StageStatus, ToolStatus } from "../useCaseLoopState.js";

export type InvestigateNodeData = {
  status: StageStatus;
  tools: { name: string; label: string; status: ToolStatus }[];
  findingCount: number;
  reasoningHead: string;
  replanCount: number;
};

export function InvestigateNode({ data }: { data: InvestigateNodeData }) {
  return (
    <div className={`sn sn--wide sn--${data.status}`}>
      <Handle type="target" position={Position.Left} />
      <Handle id="replan" type="target" position={Position.Bottom} />
      <span className="sn__title">
        investigate
        {data.replanCount > 0 && <span className="sn__replan">re-plan {data.replanCount}</span>}
      </span>
      <div className="sn__pills">
        {data.tools.map((t) => (
          <span key={t.name} className={`pill pill--${t.status}`}>
            {t.label}
          </span>
        ))}
      </div>
      {data.findingCount > 0 && (
        <span className="sn__signals">
          {data.findingCount} signal{data.findingCount === 1 ? "" : "s"}
        </span>
      )}
      {data.reasoningHead && <span className="sn__reasoning">{data.reasoningHead}</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
