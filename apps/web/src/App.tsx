import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentApi,
  api,
  type Agent,
  type Approval,
  type Mission,
  type MissionStep,
  type StepStatus,
  type Workflow,
} from "./api.js";
import { Canvas } from "./Canvas.js";
import { Command } from "./Command.js";
import { useEventStream } from "./useEventStream.js";
import { NODE_META } from "./FlowNode.js";

const SAMPLE_GRAPH = {
  nodes: [
    { id: "t1", kind: "trigger" as const, label: "Manual", config: { mode: "manual" }, position: { x: 40, y: 120 } },
    { id: "c1", kind: "code" as const, label: "Double n", config: { source: "return { doubled: (input.n ?? 0) * 2 };" }, position: { x: 250, y: 120 } },
    { id: "b1", kind: "logic" as const, label: "n > 5 ?", config: { op: "branch", expression: "out.doubled > 5" }, position: { x: 470, y: 120 } },
    { id: "a1", kind: "approval" as const, label: "Approve big", config: { prompt: "Approve big value?" }, position: { x: 690, y: 40 } },
    { id: "e1", kind: "action" as const, label: "Echo big", config: { server: "util", tool: "echo", args: { value: "APPROVED_BIG" } }, position: { x: 900, y: 40 } },
    { id: "e2", kind: "action" as const, label: "Echo small", config: { server: "util", tool: "echo", args: { value: "SMALL" } }, position: { x: 690, y: 210 } },
  ],
  edges: [
    { from: "t1", to: "c1", condition: null },
    { from: "c1", to: "b1", condition: null },
    { from: "b1", to: "a1", condition: "out === true" },
    { from: "b1", to: "e2", condition: "out === false" },
    { from: "a1", to: "e1", condition: null },
  ],
};

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "PENDING",
  running: "RUNNING",
  succeeded: "OK",
  failed: "FAIL",
  skipped: "SKIP",
  awaiting_approval: "GATE",
};

export function App() {
  const [view, setView] = useState<"command" | "canvas">("command");
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [chatRefresh, setChatRefresh] = useState(0);
  const [tracked, setTracked] = useState<string | null>(null);
  const [nodeStatus, setNodeStatus] = useState<Record<string, StepStatus>>({});
  const [mission, setMission] = useState<Mission | null>(null);
  const [steps, setSteps] = useState<MissionStep[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [info, setInfo] = useState<{ dbDriver: string; queue: string } | null>(null);

  const trackedRef = useRef<string | null>(null);
  trackedRef.current = tracked;
  const selectedAgentRef = useRef<string | null>(null);
  selectedAgentRef.current = selectedAgent;

  const refreshWorkflows = useCallback(() => api.listWorkflows().then(setWorkflows), []);
  const refreshAgents = useCallback(() => agentApi.list().then(setAgents), []);
  const refreshApprovals = useCallback(() => api.listApprovals("pending").then(setApprovals), []);
  const refreshTrace = useCallback((id: string) => {
    return api.getMission(id).then(({ mission, steps }) => {
      setMission(mission);
      setSteps(steps);
    });
  }, []);

  useEffect(() => {
    api.bootstrap().then(setInfo).catch(() => setInfo(null));
    refreshWorkflows();
    refreshAgents();
    refreshApprovals();
  }, [refreshWorkflows, refreshAgents, refreshApprovals]);

  const { connected } = useEventStream(
    useCallback(
      (event) => {
        const active = trackedRef.current;
        if (event.type === "mission.step" && event.missionId === active) {
          setNodeStatus((s) => ({ ...s, [event.nodeId]: event.status }));
          refreshTrace(active);
        } else if (event.type === "mission.started" && event.missionId === active) {
          setNodeStatus({});
        } else if (event.type === "mission.finished" && event.missionId === active) {
          refreshTrace(active);
        }
        if (event.type === "approval.requested" || event.type === "approval.resolved") {
          refreshApprovals();
          if (active) refreshTrace(active);
        }
        if (event.type === "agent.message" && event.agentId === selectedAgentRef.current) {
          setChatRefresh((n) => n + 1);
        }
      },
      [refreshApprovals, refreshTrace],
    ),
  );

  const track = (id: string) => {
    setTracked(id);
    setNodeStatus({});
    refreshTrace(id);
  };

  const newWorkflow = async () => {
    const name = prompt("Workflow name", "New workflow");
    if (name === null) return;
    const { workflow } = await api.createWorkflow(name || "New workflow", {
      nodes: [{ id: "t1", kind: "trigger", label: "Manual", config: { mode: "manual" }, position: { x: 80, y: 120 } }],
      edges: [],
    });
    await refreshWorkflows();
    setSelected(workflow.id);
  };

  const sampleWorkflow = async () => {
    const { workflow } = await api.createWorkflow("Sample: double + gated echo", SAMPLE_GRAPH);
    await refreshWorkflows();
    setSelected(workflow.id);
  };

  const decide = async (id: string, approved: boolean) => {
    await api.resolveApproval(id, approved);
    await refreshApprovals();
    if (tracked) refreshTrace(tracked);
    setChatRefresh((n) => n + 1);
  };

  const newAgent = async () => {
    const name = prompt("Agent name", "Scout");
    if (name === null) return;
    const model = prompt("Model (claude-*, openai/*, ollama/*, mock)", "mock") ?? "mock";
    const persona = prompt("Persona", "You are a helpful research assistant.") ?? "";
    const agent = await agentApi.create({ name: name || "Agent", model, persona });
    await refreshAgents();
    setSelectedAgent(agent.id);
    setView("command");
  };

  const currentAgent = agents.find((a) => a.id === selectedAgent) ?? null;

  return (
    <div className="app">
      <header className="rail">
        <span className="brand">PUPPETMASTER</span>
        <nav className="view-switch">
          <button className={`vs ${view === "command" ? "on" : ""}`} onClick={() => setView("command")}>
            COMMAND
          </button>
          <button className={`vs ${view === "canvas" ? "on" : ""}`} onClick={() => setView("canvas")}>
            CANVAS
          </button>
        </nav>
        <span className="rail-meta">
          {info && <span className="tag-lo">DB {info.dbDriver.toUpperCase()} · Q {info.queue.toUpperCase()}</span>}
          <span className={`status ${connected ? "ok" : "down"}`}>
            {connected ? "BUS ONLINE" : "BUS OFFLINE"}
          </span>
        </span>
      </header>

      <div className="grid">
        <aside className="panel side">
          {view === "command" ? (
            <>
              <div className="panel-head">
                <span>AGENTS</span>
                <span className="head-actions">
                  <button className="chip tiny" onClick={newAgent}>＋</button>
                </span>
              </div>
              <ul className="wf-list">
                {agents.length === 0 && <li className="muted pad">No agents yet.</li>}
                {agents.map((a) => (
                  <li key={a.id}>
                    <button
                      className={`wf-item ${selectedAgent === a.id ? "sel" : ""}`}
                      onClick={() => setSelectedAgent(a.id)}
                    >
                      <span className="wf-name">◉ {a.name}</span>
                      <span className="wf-ver">{a.model}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <div className="panel-head">
                <span>WORKFLOWS</span>
                <span className="head-actions">
                  <button className="chip tiny" onClick={newWorkflow}>＋</button>
                  <button className="chip tiny" onClick={sampleWorkflow}>SAMPLE</button>
                </span>
              </div>
              <ul className="wf-list">
                {workflows.length === 0 && <li className="muted pad">No workflows yet.</li>}
                {workflows.map((w) => (
                  <li key={w.id}>
                    <button className={`wf-item ${selected === w.id ? "sel" : ""}`} onClick={() => setSelected(w.id)}>
                      <span className="wf-name">{w.name}</span>
                      <span className="wf-ver">v{w.currentVersion}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <div className="panel-head">
            <span>APPROVALS</span>
            <span className="count">{approvals.length}</span>
          </div>
          <ul className="appr-list">
            {approvals.length === 0 && <li className="muted">Inbox clear.</li>}
            {approvals.map((a) => (
              <li key={a.id} className="appr">
                <div className="appr-prompt">{a.prompt}</div>
                <div className="appr-actions">
                  <button className="chip accent tiny" onClick={() => decide(a.id, true)}>APPROVE</button>
                  <button className="chip danger tiny" onClick={() => decide(a.id, false)}>REJECT</button>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <main className="panel canvas-panel">
          {view === "command" ? (
            <Command agent={currentAgent} refreshKey={chatRefresh} onRan={track} />
          ) : (
            <Canvas
              workflowId={selected}
              nodeStatus={nodeStatus}
              onRan={track}
              onSaved={refreshWorkflows}
            />
          )}
        </main>

        <aside className="panel trace">
          <div className="panel-head">
            <span>MISSION TRACE</span>
            {mission && <span className={`mstatus st-${mission.status}`}>{mission.status.toUpperCase()}</span>}
          </div>
          {mission?.parentMissionId && (
            <button className="chip tiny parent-chip" onClick={() => track(mission.parentMissionId!)}>
              ↑ NESTED · VIEW PARENT MISSION
            </button>
          )}
          {!mission && <p className="muted pad">Run a workflow to see its live trace.</p>}
          {mission && (
            <>
              <ul className="step-list">
                {steps.map((s) => (
                  <li key={s.id} className={`step st-${s.status}`}>
                    <span className="step-dot" />
                    <span className="step-node">
                      {NODE_META[s.kind]?.glyph} {s.nodeId}
                    </span>
                    <span className="step-status">{STATUS_LABEL[s.status]}</span>
                  </li>
                ))}
              </ul>
              {mission.output !== null && mission.output !== undefined && (
                <div className="mission-output">
                  <span className="tag-lo">OUTPUT</span>
                  <pre>{JSON.stringify(mission.output, null, 2)}</pre>
                </div>
              )}
              {mission.error && (
                <div className="mission-output err">
                  <span className="tag-lo">ERROR</span>
                  <pre>{mission.error}</pre>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
