import { Handle, Position } from "@xyflow/react";
import type { StageStatus } from "../useCaseLoopState.js";

export type StageNodeData = {
  title: string;
  status: StageStatus;
  detail?: string;
  replanTarget?: boolean;
  replanSource?: boolean;
};

export function StageNode({ data }: { data: StageNodeData }) {
  return (
    <div className={`sn sn--${data.status}`}>
      <Handle type="target" position={Position.Left} />
      <span className="sn__title">{data.title}</span>
      {data.detail && <span className="sn__detail">{data.detail}</span>}
      <Handle type="source" position={Position.Right} />
      {data.replanTarget && <Handle id="replan" type="target" position={Position.Bottom} />}
      {data.replanSource && <Handle id="replan" type="source" position={Position.Bottom} />}
    </div>
  );
}
