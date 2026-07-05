import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  agentApi,
  api,
  authApi,
  prefsApi,
  suggestionApi,
  type Agent,
  type Approval,
  type Me,
  type Mission,
  type MissionStep,
  type Role,
  type StepStatus,
  type Suggestion,
  type Workflow,
} from "./api.js";
import { Canvas } from "./Canvas.js";
import { Command } from "./Command.js";
import { Login } from "./Login.js";
import { AdminView, AgentsView, KnowledgeView, MissionsView, TemplatesView, ToolsView } from "./Views.js";
import { workspaceApi, type Workspace } from "./api.js";
import { useEventStream } from "./useEventStream.js";
import { NODE_META } from "./FlowNode.js";

const VIEWS = ["command", "canvas", "templates", "knowledge", "missions", "agents", "tools", "admin"] as const;
type View = (typeof VIEWS)[number];

const RANK: Record<Role, number> = { member: 0, builder: 1, admin: 2, owner: 3 };

/** Role-based navigation (ARCHITECTURE.md §5): which views each role sees… */
const ROLE_VIEWS: Record<Role, View[]> = {
  member: ["command", "templates", "knowledge", "missions", "agents", "tools"],
  builder: ["command", "canvas", "templates", "knowledge", "missions", "agents", "tools"],
  admin: [...VIEWS],
  owner: [...VIEWS],
};
/** …and where each role lands after sign-in (role dashboards). */
const ROLE_HOME: Record<Role, View> = {
  member: "command",
  builder: "canvas",
  admin: "missions",
  owner: "missions",
};

/** Arrangeable side panels: default layout per role; users override via ui_preferences. */
const PANEL_PRESET: Record<Role, { order: string[]; collapsed: Record<string, boolean> }> = {
  member: { order: ["suggested", "list", "approvals"], collapsed: { approvals: true } },
  builder: { order: ["list", "suggested", "approvals"], collapsed: {} },
  admin: { order: ["approvals", "suggested", "list"], collapsed: {} },
  owner: { order: ["approvals", "suggested", "list"], collapsed: {} },
};

function applyBranding(ws: Workspace) {
  if (ws.branding?.accent) {
    document.documentElement.style.setProperty("--accent", ws.branding.accent);
  }
}

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

/** Auth gate: resolve the session, then render the shell for the signed-in user. */
export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  const resolve = useCallback(() => {
    authApi.me().then(setMe).catch(() => setMe(null));
  }, []);
  useEffect(resolve, [resolve]);

  if (me === undefined) {
    return <div className="login-screen"><p className="dim">CONNECTING…</p></div>;
  }
  if (me === null) return <Login onAuthed={resolve} />;
  return (
    <Shell
      key={me.user.id}
      me={me}
      onSignOut={async () => {
        await authApi.logout();
        setMe(null);
      }}
    />
  );
}

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const canBuild = RANK[me.role] >= RANK.builder;
  const [view, setView] = useState<View>(ROLE_HOME[me.role]);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
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
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [missionsRefresh, setMissionsRefresh] = useState(0);
  const [info, setInfo] = useState<{ dbDriver: string; queue: string } | null>(null);

  // Arrangeable panels persisted per user (ui_preferences).
  const [panelOrder, setPanelOrder] = useState<string[]>(PANEL_PRESET[me.role].order);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(PANEL_PRESET[me.role].collapsed);
  const prefsReady = useRef(false);

  const trackedRef = useRef<string | null>(null);
  trackedRef.current = tracked;
  const selectedAgentRef = useRef<string | null>(null);
  selectedAgentRef.current = selectedAgent;

  const refreshWorkflows = useCallback(() => api.listWorkflows().then(setWorkflows), []);
  const refreshAgents = useCallback(() => agentApi.list().then(setAgents), []);
  const refreshApprovals = useCallback(() => api.listApprovals("pending").then(setApprovals), []);
  const refreshSuggestions = useCallback(
    () => suggestionApi.get().then(setSuggestions).catch(() => {}),
    [],
  );
  const refreshTrace = useCallback((id: string) => {
    return api.getMission(id).then(({ mission, steps }) => {
      setMission(mission);
      setSteps(steps);
    });
  }, []);

  useEffect(() => {
    api.bootstrap().then(setInfo).catch(() => setInfo(null));
    workspaceApi
      .get()
      .then((ws) => {
        setWorkspace(ws);
        applyBranding(ws);
      })
      .catch(() => {});
    refreshWorkflows();
    refreshAgents();
    refreshApprovals();
    refreshSuggestions();
    prefsApi
      .get()
      .then(({ layout }) => {
        if (layout.panels?.order?.length) {
          // Keep any newer section (e.g. "suggested") the saved layout predates.
          const saved = layout.panels.order;
          const merged = [...saved, ...PANEL_PRESET[me.role].order.filter((id) => !saved.includes(id))];
          setPanelOrder(merged);
        }
        if (layout.panels?.collapsed) setCollapsed(layout.panels.collapsed);
        prefsReady.current = true;
      })
      .catch(() => {
        prefsReady.current = true;
      });
  }, [refreshWorkflows, refreshAgents, refreshApprovals, refreshSuggestions]);

  // Debounced save of the panel arrangement, once initial prefs have loaded.
  useEffect(() => {
    if (!prefsReady.current) return;
    const t = setTimeout(() => {
      prefsApi.save({ panels: { order: panelOrder, collapsed } }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [panelOrder, collapsed]);

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
        if (event.type === "mission.started" || event.type === "mission.finished") {
          setMissionsRefresh((n) => n + 1);
          refreshSuggestions();
        }
        if (event.type === "approval.requested" || event.type === "approval.resolved") {
          refreshApprovals();
          if (active) refreshTrace(active);
        }
        if (event.type === "agent.message" && event.agentId === selectedAgentRef.current) {
          setChatRefresh((n) => n + 1);
        }
      },
      [refreshApprovals, refreshTrace, refreshSuggestions],
    ),
  );

  const openSuggestion = (s: Suggestion) => {
    if (s.kind === "agent") {
      setSelectedAgent(s.subjectId);
      setView("command");
    } else if (canBuild) {
      setSelected(s.subjectId);
      setView("canvas");
    } else {
      setView("missions");
    }
  };

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

  // --- Panel arrangement helpers -------------------------------------------------
  const movePanel = (id: string, dir: -1 | 1) => {
    setPanelOrder((order) => {
      const idx = order.indexOf(id);
      const to = idx + dir;
      if (idx < 0 || to < 0 || to >= order.length) return order;
      const next = [...order];
      next.splice(idx, 1);
      next.splice(to, 0, id);
      return next;
    });
  };
  const togglePanel = (id: string) => setCollapsed((c) => ({ ...c, [id]: !c[id] }));

  const panelControls = (id: string) => (
    <span className="head-actions">
      <button className="ph-btn" title="Move up" onClick={() => movePanel(id, -1)}>▲</button>
      <button className="ph-btn" title="Move down" onClick={() => movePanel(id, 1)}>▼</button>
      <button className="ph-btn" title={collapsed[id] ? "Expand" : "Collapse"} onClick={() => togglePanel(id)}>
        {collapsed[id] ? "＋" : "－"}
      </button>
    </span>
  );

  const sections: Record<string, () => JSX.Element | null> = {
    list: () => {
      if (view === "canvas" && canBuild) {
        return (
          <section key="list">
            <div className="panel-head">
              <span>WORKFLOWS</span>
              <span className="head-actions">
                {!collapsed.list && (
                  <>
                    <button className="chip tiny" onClick={newWorkflow}>＋</button>
                    <button className="chip tiny" onClick={sampleWorkflow}>SAMPLE</button>
                  </>
                )}
                {panelControls("list")}
              </span>
            </div>
            {!collapsed.list && (
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
            )}
          </section>
        );
      }
      if (view !== "command") return null;
      return (
        <section key="list">
          <div className="panel-head">
            <span>AGENTS</span>
            <span className="head-actions">
              {canBuild && !collapsed.list && <button className="chip tiny" onClick={newAgent}>＋</button>}
              {panelControls("list")}
            </span>
          </div>
          {!collapsed.list && (
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
          )}
        </section>
      );
    },
    suggested: () => (
      <section key="suggested">
        <div className="panel-head">
          <span>SUGGESTED</span>
          <span className="head-actions">
            <span className="tag-lo" title="Frequently used, from mission history">ADAPTIVE</span>
            {panelControls("suggested")}
          </span>
        </div>
        {!collapsed.suggested && (
          <ul className="wf-list">
            {suggestions.length === 0 && <li className="muted pad">Run agents or workflows to build suggestions.</li>}
            {suggestions.map((s) => (
              <li key={s.subjectId}>
                <button className="wf-item" onClick={() => openSuggestion(s)}>
                  <span className="wf-name">{s.kind === "agent" ? "◉" : "▤"} {s.name}</span>
                  <span className="wf-ver">{s.runs}×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    ),
    approvals: () => (
      <section key="approvals">
        <div className="panel-head">
          <span>APPROVALS</span>
          <span className="head-actions">
            <span className="count">{approvals.length}</span>
            {panelControls("approvals")}
          </span>
        </div>
        {!collapsed.approvals && (
          <ul className="appr-list">
            {approvals.length === 0 && <li className="muted">Inbox clear.</li>}
            {approvals.map((a) => (
              <li key={a.id} className="appr">
                <div className="appr-prompt">{a.prompt}</div>
                {canBuild ? (
                  <div className="appr-actions">
                    <button className="chip accent tiny" onClick={() => decide(a.id, true)}>APPROVE</button>
                    <button className="chip danger tiny" onClick={() => decide(a.id, false)}>REJECT</button>
                  </div>
                ) : (
                  <div className="appr-actions"><span className="tag-lo">BUILDER+ ONLY</span></div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    ),
  };

  return (
    <div className="app">
      <header className="rail">
        <span className="brand">{workspace?.branding?.brandName || "PUPPETMASTER"}</span>
        <nav className="view-switch">
          {ROLE_VIEWS[me.role].map((v) => (
            <button key={v} className={`vs ${view === v ? "on" : ""}`} onClick={() => setView(v)}>
              {v.toUpperCase()}
            </button>
          ))}
        </nav>
        <span className="rail-meta">
          {info && <span className="tag-lo">DB {info.dbDriver.toUpperCase()} · Q {info.queue.toUpperCase()}</span>}
          <span className={`status ${connected ? "ok" : "down"}`}>
            {connected ? "BUS ONLINE" : "BUS OFFLINE"}
          </span>
          <span className="user-chip" title={me.user.email}>
            {me.user.name.toUpperCase()} · {me.role.toUpperCase()}
          </span>
          <button className="chip tiny" onClick={onSignOut}>SIGN OUT</button>
        </span>
      </header>

      <div className={`grid ${collapsed.trace ? "no-trace" : ""}`}>
        <aside className="panel side">
          {panelOrder.map((id) => sections[id]?.() ?? null)}
        </aside>

        <main className="panel canvas-panel">
          {view === "command" && <Command agent={currentAgent} refreshKey={chatRefresh} onRan={track} />}
          {view === "canvas" && canBuild && (
            <Canvas workflowId={selected} nodeStatus={nodeStatus} onRan={track} onSaved={refreshWorkflows} />
          )}
          {view === "templates" && (
            <TemplatesView
              canBuild={canBuild}
              onInstantiated={(kind, id) => {
                if (kind === "workflow") {
                  refreshWorkflows();
                  setSelected(id);
                  if (canBuild) setView("canvas");
                } else {
                  refreshAgents();
                  setSelectedAgent(id);
                  setView("command");
                }
              }}
            />
          )}
          {view === "knowledge" && <KnowledgeView canBuild={canBuild} />}
          {view === "missions" && (
            <MissionsView selected={tracked} onSelect={track} refreshKey={missionsRefresh} />
          )}
          {view === "agents" && (
            <AgentsView
              readOnly={!canBuild}
              onOpenChat={(id) => {
                setSelectedAgent(id);
                setView("command");
              }}
            />
          )}
          {view === "tools" && <ToolsView />}
          {view === "admin" && RANK[me.role] >= RANK.admin && (
            <AdminView
              meId={me.user.id}
              onBrandingChange={(ws) => {
                setWorkspace(ws);
                applyBranding(ws);
              }}
            />
          )}
        </main>

        <aside className="panel trace">
          <div className="panel-head">
            <span>{collapsed.trace ? "TRACE" : "MISSION TRACE"}</span>
            <span className="head-actions">
              {mission && !collapsed.trace && (
                <span className={`mstatus st-${mission.status}`}>{mission.status.toUpperCase()}</span>
              )}
              <button className="ph-btn" title={collapsed.trace ? "Expand" : "Collapse"} onClick={() => togglePanel("trace")}>
                {collapsed.trace ? "＋" : "－"}
              </button>
            </span>
          </div>
          {!collapsed.trace && (
            <>
              {mission?.parentMissionId && (
                <button className="chip tiny parent-chip" onClick={() => track(mission.parentMissionId!)}>
                  ↑ NESTED · VIEW PARENT MISSION
                </button>
              )}
              {!mission && <p className="muted pad">Run a workflow to see its live trace.</p>}
              {mission && canBuild && (
                <div className="pad" style={{ display: "flex", gap: 8 }}>
                  {["queued", "running", "awaiting_approval"].includes(mission.status) && (
                    <button
                      className="chip tiny"
                      onClick={() => api.cancelMission(mission.id).then(() => refreshTrace(mission.id)).catch(() => {})}
                    >
                      ✕ CANCEL
                    </button>
                  )}
                  {["failed", "cancelled"].includes(mission.status) && (
                    <button
                      className="chip tiny"
                      onClick={() => api.retryMission(mission.id).then(() => refreshTrace(mission.id)).catch(() => {})}
                    >
                      ↻ RETRY
                    </button>
                  )}
                </div>
              )}
              {mission && (
                <>
                  {(() => {
                    const t = steps.reduce(
                      (acc, s) => {
                        const u = (s.output as { usage?: { inputTokens?: number; outputTokens?: number } } | null)?.usage;
                        if (u) {
                          acc.in += u.inputTokens ?? 0;
                          acc.out += u.outputTokens ?? 0;
                        }
                        return acc;
                      },
                      { in: 0, out: 0 },
                    );
                    return t.in + t.out > 0 ? (
                      <div className="trace-cost tag-lo">COST · {t.in} TOK IN · {t.out} TOK OUT</div>
                    ) : null;
                  })()}
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
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
