import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  MarkerType,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { EdgeId, LoopState } from "./useCaseLoopState.js";
import { StageNode } from "./nodes/StageNode.js";
import { InvestigateNode } from "./nodes/InvestigateNode.js";
import { GateNode } from "./nodes/GateNode.js";
import { FlowEdge } from "./edges/FlowEdge.js";

const nodeTypes = { stage: StageNode, investigate: InvestigateNode, gate: GateNode };
const edgeTypes = { flow: FlowEdge };

const POS: Record<string, { x: number; y: number }> = {
  incoming: { x: 0, y: 70 },
  investigate: { x: 168, y: 6 },
  propose: { x: 432, y: 64 },
  gate: { x: 606, y: 52 },
  execute: { x: 842, y: 64 },
  outcome: { x: 1036, y: 64 },
};

const marker = { type: MarkerType.ArrowClosed, width: 13, height: 13, color: "#5a5f6b" };

function flowEdge(id: string, source: string, target: string, current: EdgeId | null, key: EdgeId): Edge {
  return { id, source, target, type: "flow", markerEnd: marker, data: { animated: current === key } };
}

function buildNodes(state: LoopState): Node[] {
  const s = state.stages;
  const attemptDetail = state.attempt?.razorpayRef ?? (state.attempt ? state.attempt.status.toLowerCase() : undefined);
  const raw = [
    { id: "incoming", type: "stage", position: POS.incoming!, data: { title: "incoming", status: s.INCOMING } },
    {
      id: "investigate",
      type: "investigate",
      position: POS.investigate!,
      data: {
        status: s.INVESTIGATE,
        tools: state.tools,
        findingCount: state.findingCount,
        reasoningHead: state.reasoningHead,
        replanCount: state.replanCount,
      },
    },
    {
      id: "propose",
      type: "stage",
      position: POS.propose!,
      data: { title: "propose", status: s.PROPOSE, detail: state.proposal?.action },
    },
    { id: "gate", type: "gate", position: POS.gate!, data: { status: s.GATE, gate: state.gate } },
    {
      id: "execute",
      type: "stage",
      position: POS.execute!,
      data: { title: "execute", status: s.EXECUTE, detail: attemptDetail },
    },
    {
      id: "outcome",
      type: "stage",
      position: POS.outcome!,
      data: {
        title: "outcome",
        status: s.OUTCOME,
        detail: state.finalLane?.replace(/_/g, " ").toLowerCase(),
        replanSource: true,
      },
    },
  ];
  return raw.map((n) => ({ ...n, draggable: false, selectable: false, connectable: false }) as Node);
}

function buildEdges(state: LoopState): Edge[] {
  const c = state.currentEdge;
  return [
    flowEdge("e1", "incoming", "investigate", c, "INCOMING-INVESTIGATE"),
    flowEdge("e2", "investigate", "propose", c, "INVESTIGATE-PROPOSE"),
    flowEdge("e3", "propose", "gate", c, "PROPOSE-GATE"),
    flowEdge("e4", "gate", "execute", c, "GATE-EXECUTE"),
    flowEdge("e5", "execute", "outcome", c, "EXECUTE-OUTCOME"),
    {
      id: "e6",
      source: "outcome",
      target: "investigate",
      sourceHandle: "replan",
      targetHandle: "replan",
      type: "flow",
      markerEnd: marker,
      data: { replan: true, animated: c === "OUTCOME-INVESTIGATE" },
    },
  ];
}

function signature(state: LoopState): string {
  return [
    Object.values(state.stages).join(""),
    state.tools.map((t) => t.status).join(""),
    state.currentEdge ?? "",
    state.replanCount,
    state.reasoningHead.length,
    state.proposal?.action ?? "",
    state.gate?.outcome ?? "",
    state.attempt?.razorpayRef ?? "",
  ].join("|");
}

function Graph({ state }: { state: LoopState }) {
  const sig = signature(state);
  const nodes = useMemo(() => buildNodes(state), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo(() => buildEdges(state), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const { fitView } = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.14, duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [sig, fitView]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitView({ padding: 0.14 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView]);

  return (
    <div className="loop-graph" ref={wrap}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.14 }}
        onInit={(inst) => inst.fitView({ padding: 0.14 })}
        minZoom={0.2}
        maxZoom={1.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
      />
    </div>
  );
}

export function LoopGraph({ state }: { state: LoopState }) {
  return (
    <ReactFlowProvider>
      <Graph state={state} />
    </ReactFlowProvider>
  );
}
