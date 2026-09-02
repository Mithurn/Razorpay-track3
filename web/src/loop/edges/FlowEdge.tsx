import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

export type FlowEdgeData = { animated?: boolean; replan?: boolean };

export function FlowEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd } = props;
  const data = (props.data ?? {}) as FlowEdgeData;
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: data.replan ? 0.6 : 0.25,
  });
  const className = ["flow-edge", data.replan ? "flow-edge--replan" : "", data.animated ? "flow-edge--animated" : ""]
    .filter(Boolean)
    .join(" ");
  return <BaseEdge id={props.id} path={path} markerEnd={markerEnd} className={className} />;
}
