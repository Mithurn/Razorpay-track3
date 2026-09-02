import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  MarkerType,
  Position,
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

// Snake layout: row 1 flows right (incoming → investigate → propose), drops to row 2, which
// flows left (gate → execute → outcome). The dashed re-plan edge loops outcome back up to
// investigate — the shape is literally the loop.
type Spec = {
  id: string;
  type: string;
  x: number;
  y: number;
  sourcePos: Position;
  targetPos: Position;
};

const SPECS: Spec[] = [
  { id: "incoming", type: "stage", x: 40, y: 70, sourcePos: Position.Right, targetPos: Position.Left },
  { id: "investigate", type: "investigate", x: 280, y: 0, sourcePos: Position.Right, targetPos: Position.Left },
  { id: "propose", type: "stage", x: 720, y: 70, sourcePos: Position.Bottom, targetPos: Position.Left },
  { id: "gate", type: "gate", x: 700, y: 340, sourcePos: Position.Left, targetPos: Position.Top },
  { id: "execute", type: "stage", x: 360, y: 350, sourcePos: Position.Left, targetPos: Position.Right },
  { id: "outcome", type: "stage", x: 60, y: 350, sourcePos: Position.Top, targetPos: Position.Right },
];

const marker = { type: MarkerType.ArrowClosed, width: 15, height: 15, color: "#5a5f6b" };

function flowEdge(id: string, source: string, target: string, current: EdgeId | null, key: EdgeId): Edge {
  return { id, source, target, type: "flow", markerEnd: marker, data: { animated: current === key } };
}

function nodeData(id: string, state: LoopState) {
  const s = state.stages;
  switch (id) {
    case "incoming":
      return { title: "incoming", status: s.INCOMING };
    case "investigate":
      return {
        status: s.INVESTIGATE,
        tools: state.tools,
        findingCount: state.findingCount,
        reasoningHead: state.reasoningHead,
        replanCount: state.replanCount,
      };
    case "propose":
      return { title: "propose", status: s.PROPOSE, detail: state.proposal?.action };
    case "gate":
      return { status: s.GATE, gate: state.gate };
    case "execute":
      return {
        title: "execute",
        status: s.EXECUTE,
        detail: state.attempt?.razorpayRef ?? (state.attempt ? state.attempt.status.toLowerCase() : undefined),
      };
    default:
      return {
        title: "outcome",
        status: s.OUTCOME,
        detail: state.finalLane?.replace(/_/g, " ").toLowerCase(),
        replanSource: true,
      };
  }
}

function buildNodes(state: LoopState): Node[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    type: spec.type,
    position: { x: spec.x, y: spec.y },
    sourcePosition: spec.sourcePos,
    targetPosition: spec.targetPos,
    draggable: false,
    selectable: false,
    connectable: false,
    data: { ...nodeData(spec.id, state), sourcePos: spec.sourcePos, targetPos: spec.targetPos },
  }));
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

// full signature — any visible change rebuilds the nodes
function signature(state: LoopState): string {
  return [
    layoutSig(state),
    state.tools.map((t) => t.status).join(""),
    state.reasoningHead,
    state.findingCount,
  ].join("|");
}

// structural signature — only these drive a re-fit, so streaming prose doesn't thrash the view
function layoutSig(state: LoopState): string {
  return [
    Object.values(state.stages).join(""),
    state.currentEdge ?? "",
    state.replanCount,
    state.proposal?.action ?? "",
    state.gate?.outcome ?? "",
    state.attempt?.razorpayRef ?? "",
  ].join("|");
}

function Graph({ state }: { state: LoopState }) {
  const sig = signature(state);
  const lay = layoutSig(state);
  const nodes = useMemo(() => buildNodes(state), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const edges = useMemo(() => buildEdges(state), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  const { fitView } = useReactFlow();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => fitView({ padding: 0.12, duration: 240 }));
    return () => cancelAnimationFrame(id);
  }, [lay, fitView]);

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
        maxZoom={2.2}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick
      >
        <Controls showInteractive={false} />
      </ReactFlow>
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
