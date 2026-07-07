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
  verify: { glyph: "✓", tag: "VERIFY" },
};

export interface FlowNodeData {
  kind: NodeKind;
  label: string;
  config: Record<string, unknown>;
  status?: StepStatus;
  [key: string]: unknown;
}

/**
 * Canvas node as an instrument module (DESIGN-LANGUAGE v0.2): kind rail with
 * glyph + node id, label body, live status footer, corner brackets, and a
 * scanline sweep while the step runs (reduced-motion safe — the sweep layer
 * only animates under `prefers-reduced-motion: no-preference`).
 */
export function FlowNode({ id, data, selected }: NodeProps & { data: FlowNodeData }) {
  const meta = NODE_META[data.kind];
  const status = data.status;
  return (
    <div className={`fnode kind-${data.kind} ${selected ? "sel" : ""} ${status ? `st-${status}` : ""}`}>
      <span className="bracket tl" />
      <span className="bracket tr" />
      <span className="bracket bl" />
      <span className="bracket br" />
      <span className="fnode-scan" aria-hidden="true" />
      <Handle type="target" position={Position.Left} />
      <div className="fnode-rail">
        <span className="fnode-glyph">{meta.glyph}</span>
        <span className="fnode-tag">{meta.tag}</span>
        <span className="fnode-id">{id}</span>
      </div>
      <div className="fnode-label">{data.label}</div>
      <div className="fnode-foot">
        <span className={`fnode-dot ${status ? `st-${status}` : ""}`} />
        <span className="fnode-status">{status ? status.replace(/_/g, " ") : "standby"}</span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
