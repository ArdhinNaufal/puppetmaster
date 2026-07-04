import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { NodeKind, StepStatus } from "./api.js";

/** Per-kind presentation: a short glyph + small-caps tag, per DESIGN-LANGUAGE.md. */
export const NODE_META: Record<NodeKind, { glyph: string; tag: string }> = {
  trigger: { glyph: "⏵", tag: "TRIGGER" },
  action: { glyph: "◆", tag: "ACTION" },
  logic: { glyph: "⑂", tag: "LOGIC" },
  code: { glyph: "{ }", tag: "CODE" },
  agent: { glyph: "◉", tag: "AGENT" },
  approval: { glyph: "⚑", tag: "APPROVAL" },
};

export interface FlowNodeData {
  kind: NodeKind;
  label: string;
  config: Record<string, unknown>;
  status?: StepStatus;
  [key: string]: unknown;
}

export function FlowNode({ data, selected }: NodeProps & { data: FlowNodeData }) {
  const meta = NODE_META[data.kind];
  const status = data.status;
  return (
    <div className={`fnode kind-${data.kind} ${selected ? "sel" : ""} ${status ? `st-${status}` : ""}`}>
      <span className="bracket tl" />
      <span className="bracket tr" />
      <span className="bracket bl" />
      <span className="bracket br" />
      <Handle type="target" position={Position.Left} />
      <div className="fnode-rail">
        <span className="fnode-glyph">{meta.glyph}</span>
        <span className="fnode-tag">{meta.tag}</span>
        {status && <span className={`fnode-dot st-${status}`} title={status} />}
      </div>
      <div className="fnode-label">{data.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
