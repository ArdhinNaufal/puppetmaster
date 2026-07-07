import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addEdge,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api, VERIFY_CHECK_NAMES, type LintIssue, type NodeKind, type StepStatus, type WorkflowGraph } from "./api.js";
import { FlowNode, NODE_META, type FlowNodeData } from "./FlowNode.js";

const nodeTypes = { fui: FlowNode };

const DEFAULT_CONFIG: Record<NodeKind, Record<string, unknown>> = {
  trigger: { mode: "manual" },
  action: { server: "util", tool: "echo", args: { value: "hello" } },
  logic: { op: "passthrough" },
  code: { source: "return input;" },
  agent: { agentId: "", message: "{{input}}" },
  approval: { prompt: "Approve this step?" },
  verify: { projectId: "{{input.projectId}}", check: "test", retriesBeforeEscalate: 8 },
};

function graphToFlow(graph: WorkflowGraph): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = graph.nodes.map((n) => ({
    id: n.id,
    type: "fui",
    position: n.position ?? { x: 0, y: 0 },
    data: { kind: n.kind, label: n.label, config: n.config } as FlowNodeData,
  }));
  const edges: Edge[] = graph.edges.map((e, i) => ({
    id: `e${i}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    label: e.condition ?? undefined,
    data: { condition: e.condition ?? null },
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  return { nodes, edges };
}

function flowToGraph(nodes: Node[], edges: Edge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => {
      const d = n.data as FlowNodeData;
      return { id: n.id, kind: d.kind, label: d.label, config: d.config, position: n.position };
    }),
    edges: edges.map((e) => ({
      from: e.source,
      to: e.target,
      condition: ((e.data as { condition?: string | null })?.condition ?? null) || null,
    })),
  };
}

export function Canvas(props: {
  workflowId: string | null;
  nodeStatus: Record<string, StepStatus>;
  onRan: (missionId: string) => void;
  onSaved: () => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [runInput, setRunInput] = useState('{ "n": 10 }');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [webhook, setWebhook] = useState<{ url: string; secret: string | null } | null>(null);
  const [describe, setDescribe] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [lintIssues, setLintIssues] = useState<LintIssue[] | null>(null);

  // Load the selected workflow's graph.
  useEffect(() => {
    if (!props.workflowId) {
      setNodes([]);
      setEdges([]);
      return;
    }
    api.getWorkflow(props.workflowId).then(({ version }) => {
      const flow = graphToFlow(version.graph);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setSelNode(null);
      setSelEdge(null);
    });
  }, [props.workflowId, setNodes, setEdges]);

  // Overlay live step status coming from the event stream onto the nodes.
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const status = props.nodeStatus[n.id];
        const d = n.data as FlowNodeData;
        return status === d.status ? n : { ...n, data: { ...d, status } };
      }),
    );
  }, [props.nodeStatus, setNodes]);

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((eds) =>
        addEdge({ ...c, data: { condition: null }, markerEnd: { type: MarkerType.ArrowClosed } }, eds),
      ),
    [setEdges],
  );

  const addNode = (kind: NodeKind) => {
    const id = crypto.randomUUID().slice(0, 8);
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: "fui",
        position: { x: 120 + Math.random() * 260, y: 80 + Math.random() * 220 },
        data: { kind, label: NODE_META[kind].tag[0] + NODE_META[kind].tag.slice(1).toLowerCase(), config: { ...DEFAULT_CONFIG[kind] } },
      },
    ]);
  };

  // NL→draft (Stage 6): the model drafts a graph rendered as *editable* state
  // — nothing is saved until the builder hits SAVE (human-in-command).
  const draft = async () => {
    if (!describe.trim() || drafting) return;
    setDrafting(true);
    setMsg(null);
    try {
      const res = await api.draftWorkflow(describe.trim());
      const flow = graphToFlow(res.graph);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setLintIssues(res.issues);
      setMsg(`draft loaded (${res.source}) — review, then SAVE to keep it`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "draft failed");
    } finally {
      setDrafting(false);
    }
  };

  const lint = async () => {
    try {
      setLintIssues(await api.lintWorkflow(flowToGraph(nodes, edges)));
    } catch {
      setLintIssues(null);
    }
  };

  const save = useCallback(async () => {
    if (!props.workflowId) return null;
    const graph = flowToGraph(nodes, edges);
    const v = await api.saveWorkflow(props.workflowId, graph);
    props.onSaved();
    setMsg(`saved v${v.version}`);
    return graph;
  }, [props, nodes, edges]);

  const run = async () => {
    if (!props.workflowId) return;
    setBusy(true);
    setMsg(null);
    try {
      await save();
      let input: unknown = {};
      try {
        input = runInput.trim() ? JSON.parse(runInput) : {};
      } catch {
        setMsg("run input is not valid JSON");
        setBusy(false);
        return;
      }
      const { missionId } = await api.runWorkflow(props.workflowId, input);
      props.onRan(missionId);
      setMsg("mission launched");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "run failed");
    } finally {
      setBusy(false);
    }
  };

  const selectedNode = nodes.find((n) => n.id === selNode);
  const selectedEdge = edges.find((e) => e.id === selEdge);

  const patchNode = (patch: Partial<FlowNodeData>) => {
    setNodes((nds) =>
      nds.map((n) => (n.id === selNode ? { ...n, data: { ...(n.data as FlowNodeData), ...patch } } : n)),
    );
  };
  const patchEdgeCondition = (condition: string) => {
    setEdges((eds) =>
      eds.map((e) =>
        e.id === selEdge ? { ...e, label: condition || undefined, data: { condition: condition || null } } : e,
      ),
    );
  };
  const deleteSelected = () => {
    if (selNode) {
      setNodes((nds) => nds.filter((n) => n.id !== selNode));
      setEdges((eds) => eds.filter((e) => e.source !== selNode && e.target !== selNode));
      setSelNode(null);
    }
    if (selEdge) {
      setEdges((eds) => eds.filter((e) => e.id !== selEdge));
      setSelEdge(null);
    }
  };

  const kinds = useMemo(() => Object.keys(NODE_META) as NodeKind[], []);

  if (!props.workflowId) {
    return <div className="canvas-empty">Select or create a workflow to edit its graph.</div>;
  }

  return (
    <div className="canvas-wrap">
      <div className="canvas-toolbar">
        <span className="tb-label">ADD</span>
        {kinds.map((k) => (
          <button key={k} className="chip" onClick={() => addNode(k)}>
            {NODE_META[k].glyph} {NODE_META[k].tag}
          </button>
        ))}
        <span className="tb-sep" />
        <input
          className="run-input"
          value={runInput}
          onChange={(e) => setRunInput(e.target.value)}
          spellCheck={false}
          aria-label="Run input JSON"
        />
        <button className="chip solid" onClick={save}>
          SAVE
        </button>
        <button className="chip accent" onClick={run} disabled={busy}>
          {busy ? "…" : "▶ RUN"}
        </button>
        {nodes.some((n) => (n.data as { kind?: NodeKind })?.kind === "trigger" && (n.data as { config?: { mode?: string } })?.config?.mode === "webhook") && props.workflowId && (
          <button
            className="chip"
            onClick={async () => {
              const w = await api.getWebhook(props.workflowId!);
              setWebhook({ url: w.url, secret: w.secret });
            }}
          >
            ⚿ WEBHOOK
          </button>
        )}
        {msg && <span className="tb-msg">{msg}</span>}
      </div>
      <div className="canvas-toolbar">
        <span className="tb-label">COPILOT</span>
        <input
          className="run-input"
          style={{ flex: 1, minWidth: 220 }}
          placeholder="Describe a workflow… e.g. 'daily: fetch api, summarize with agent, email me'"
          value={describe}
          onChange={(e) => setDescribe(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && draft()}
        />
        <button className="chip accent" onClick={draft} disabled={drafting || !describe.trim()}>
          {drafting ? "…" : "✎ DRAFT"}
        </button>
        <button className="chip" onClick={lint}>⚖ LINT</button>
        {lintIssues !== null && (
          <span className="tb-msg">
            {lintIssues.length === 0
              ? "lint: clean"
              : `${lintIssues.filter((i) => i.severity === "error").length} errors · ${lintIssues.filter((i) => i.severity === "warning").length} warnings`}
          </span>
        )}
      </div>
      {lintIssues !== null && lintIssues.length > 0 && (
        <div className="webhook-reveal">
          {lintIssues.map((i, n) => (
            <span key={n} className={i.severity === "error" ? "wh-secret" : "wh-hint"}>
              {i.severity.toUpperCase()} [{i.code}] {i.message}
            </span>
          ))}
          <button className="chip tiny" onClick={() => setLintIssues(null)}>CLOSE</button>
        </div>
      )}
      {webhook && (
        <div className="webhook-reveal">
          <span className="tag-lo">SIGNED WEBHOOK</span>
          <code>POST {webhook.url}</code>
          <span className="tag-lo">SECRET</span>
          <code className="wh-secret">{webhook.secret ?? "(none)"}</code>
          <span className="wh-hint">
            X-Puppetmaster-Signature: sha256=HMAC_SHA256(secret, body)
          </span>
          <button
            className="chip tiny"
            onClick={async () => {
              if (props.workflowId) {
                const r = await api.rotateWebhook(props.workflowId);
                setWebhook((w) => (w ? { ...w, secret: r.secret } : w));
              }
            }}
          >
            ROTATE
          </button>
          <button className="chip tiny" onClick={() => setWebhook(null)}>CLOSE</button>
        </div>
      )}

      <div className={`canvas-body ${Object.values(props.nodeStatus).some((s) => s === "running") ? "canvas-live" : ""}`}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, n) => {
            setSelNode(n.id);
            setSelEdge(null);
          }}
          onEdgeClick={(_, e) => {
            setSelEdge(e.id);
            setSelNode(null);
          }}
          onPaneClick={() => {
            setSelNode(null);
            setSelEdge(null);
          }}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#16232a" />
          <Controls showInteractive={false} />
        </ReactFlow>

        {(selectedNode || selectedEdge) && (
          <aside className="inspector">
            <div className="ins-head">
              <span>{selectedNode ? "NODE" : "EDGE"}</span>
              <button className="chip danger tiny" onClick={deleteSelected}>
                DELETE
              </button>
            </div>
            {selectedNode && (
              <>
                <label className="ins-field">
                  <span>Label</span>
                  <input
                    value={(selectedNode.data as FlowNodeData).label}
                    onChange={(e) => patchNode({ label: e.target.value })}
                  />
                </label>
                {(selectedNode.data as FlowNodeData).kind === "verify" ? (
                  <VerifyConfigFields
                    node={selectedNode}
                    onPatch={(cfg) => patchNode({ config: cfg })}
                  />
                ) : (
                  <label className="ins-field">
                    <span>Config (JSON)</span>
                    <textarea
                      rows={10}
                      spellCheck={false}
                      defaultValue={JSON.stringify((selectedNode.data as FlowNodeData).config, null, 2)}
                      key={selectedNode.id}
                      onBlur={(e) => {
                        try {
                          patchNode({ config: JSON.parse(e.target.value) });
                          setMsg(null);
                        } catch {
                          setMsg("config is not valid JSON");
                        }
                      }}
                    />
                  </label>
                )}
                <p className="ins-hint">kind: {(selectedNode.data as FlowNodeData).kind}</p>
              </>
            )}
            {selectedEdge && (
              <label className="ins-field">
                <span>Condition (JS on `out`)</span>
                <input
                  placeholder="e.g. out === true"
                  defaultValue={(selectedEdge.data as { condition?: string | null })?.condition ?? ""}
                  key={selectedEdge.id}
                  onBlur={(e) => patchEdgeCondition(e.target.value)}
                />
              </label>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

/** Structured config inspector for verify nodes (WP7.4): a check picker +
 *  retries-before-escalate + project / optional fix-agent, instead of raw JSON
 *  — the verify node's config is a fixed shape (shared VerifyNodeConfig), so a
 *  typed form beats a JSON blob for the earned-gate the corpus centres on. */
function VerifyConfigFields(props: { node: Node; onPatch: (cfg: Record<string, unknown>) => void }) {
  const cfg = (props.node.data as FlowNodeData).config as {
    projectId?: string;
    check?: string;
    retriesBeforeEscalate?: number;
    fixAgentId?: string;
  };
  const set = (patch: Record<string, unknown>) => props.onPatch({ ...cfg, ...patch });
  return (
    <>
      <label className="ins-field">
        <span>Project ID</span>
        <input
          defaultValue={cfg.projectId ?? ""}
          key={`${props.node.id}-pid`}
          placeholder="{{input.projectId}}"
          onBlur={(e) => set({ projectId: e.target.value })}
        />
      </label>
      <label className="ins-field">
        <span>Check</span>
        <select value={cfg.check ?? "test"} onChange={(e) => set({ check: e.target.value })}>
          {VERIFY_CHECK_NAMES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="ins-field">
        <span>Retries before escalate (1–20)</span>
        <input
          type="number"
          min={1}
          max={20}
          defaultValue={cfg.retriesBeforeEscalate ?? 8}
          key={`${props.node.id}-retries`}
          onBlur={(e) =>
            set({ retriesBeforeEscalate: Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 8))) })
          }
        />
      </label>
      <label className="ins-field">
        <span>Fix agent ID (optional)</span>
        <input
          defaultValue={cfg.fixAgentId ?? ""}
          key={`${props.node.id}-fix`}
          placeholder="none — escalate on first failure"
          onBlur={(e) => {
            const v = e.target.value.trim();
            const next = { ...cfg } as Record<string, unknown>;
            if (v) next.fixAgentId = v;
            else delete next.fixAgentId;
            props.onPatch(next);
          }}
        />
      </label>
    </>
  );
}
