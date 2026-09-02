import { Handle, Position } from "@xyflow/react";
import type { StageStatus } from "../useCaseLoopState.js";

export type StageNodeData = {
  title: string;
  status: StageStatus;
  detail?: string;
  sourcePos?: Position;
  targetPos?: Position;
  replanSource?: boolean;
};

export function StageNode({ data }: { data: StageNodeData }) {
  return (
    <div className={`sn sn--${data.status}`}>
      <Handle type="target" position={data.targetPos ?? Position.Left} />
      <span className="sn__title">{data.title}</span>
      {data.detail && <span className="sn__detail">{data.detail}</span>}
      <Handle type="source" position={data.sourcePos ?? Position.Right} />
      {data.replanSource && <Handle id="replan" type="source" position={Position.Top} />}
    </div>
  );
}
