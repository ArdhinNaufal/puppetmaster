import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { Decode, HoldButton } from "@puppetmaster/ui";
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
import { Nexus } from "./nexus/Nexus.js";
import { ROLE_RANK, TASKS } from "./nexus/registry.js";
import { Palette, type PaletteAction } from "./Palette.js";
import { SignalRadar, SignalTicker, toSignal, type SignalEntry } from "./Signal.js";
import { TraceDossier, type StepTiming } from "./Trace.js";
import { AdminView, AgentsView, EvalsView, KnowledgeView, MissionsView, TemplatesView, ToolsView } from "./Views.js";
import { workspaceApi, type Workspace } from "./api.js";
import { useEventStream } from "./useEventStream.js";

const VIEWS = ["nexus", "command", "canvas", "templates", "knowledge", "missions", "agents", "tools", "evals", "admin"] as const;
type View = (typeof VIEWS)[number];

const RANK: Record<Role, number> = { member: 0, builder: 1, admin: 2, owner: 3 };

/** Role-based navigation (ARCHITECTURE.md §5): which views each role sees… */
const ROLE_VIEWS: Record<Role, View[]> = {
  member: ["nexus", "command", "templates", "knowledge", "missions", "agents", "tools"],
  builder: ["nexus", "command", "canvas", "templates", "knowledge", "missions", "agents", "tools"],
  admin: [...VIEWS],
  owner: [...VIEWS],
};
/** …and where each role lands after sign-in (role dashboards). */
const ROLE_HOME: Record<Role, View> = {
  member: "nexus",
  builder: "canvas",
  admin: "missions",
  owner: "missions",
};

/** Arrangeable side panels: default layout per role; users override via ui_preferences. */
const PANEL_PRESET: Record<Role, { order: string[]; collapsed: Record<string, boolean> }> = {
  member: { order: ["signal", "suggested", "list", "approvals"], collapsed: { approvals: true } },
  builder: { order: ["list", "suggested", "approvals", "signal"], collapsed: {} },
  admin: { order: ["approvals", "signal", "suggested", "list"], collapsed: {} },
  owner: { order: ["approvals", "signal", "suggested", "list"], collapsed: {} },
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

/** True when the key event originates from a typing context. */
function typing(e: KeyboardEvent): boolean {
  const t = e.target;
  return (
    t instanceof HTMLElement &&
    (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
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
  const [streamText, setStreamText] = useState("");
  const [diagnosis, setDiagnosis] = useState<{ summary: string; diagnosis: string } | null>(null);
  const [info, setInfo] = useState<{ dbDriver: string; queue: string } | null>(null);

  // Signal instruments: every bus event is witnessed (ticker + radar).
  const [signals, setSignals] = useState<SignalEntry[]>([]);
  const [rxTotal, setRxTotal] = useState(0);
  const sessionStart = useRef(Date.now());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [nexusSpawn, setNexusSpawn] = useState<{ task: string; ctx?: Record<string, unknown>; n: number } | null>(null);
  const spawnSeq = useRef(0);
  const reducedMotion = useMemo(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
    [],
  );

  // Observed per-step timing (from mission.step bus events) — feeds the dossier gantt.
  const timingRef = useRef<Record<string, Record<string, StepTiming>>>({});

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
          // Keep any newer section (e.g. "signal") the saved layout predates.
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
        setRxTotal((n) => n + 1);
        // The dossier's gantt uses observed timing; streaming deltas are too
        // chatty for the ticker and are counted (RX) but not listed.
        if (event.type === "mission.step") {
          const m = (timingRef.current[event.missionId] ??= {});
          const t = (m[event.nodeId] ??= {});
          const at = Date.parse(event.at) || Date.now();
          if (event.status === "running") t.start = at;
          else if (event.status !== "pending") t.end = at;
        }
        if (event.type === "mission.started") timingRef.current[event.missionId] = {};
        if (event.type !== "agent.message.delta") {
          const entry = toSignal(event);
          setSignals((s) => [entry, ...s].slice(0, 60));
        }

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
          if (event.role === "assistant") setStreamText("");
        }
        if (event.type === "agent.message.delta" && event.agentId === selectedAgentRef.current) {
          setStreamText((t) => t + event.delta);
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
    setDiagnosis(null);
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
  const roleViews = ROLE_VIEWS[me.role];

  // --- Keyboard: ⌘K palette, 1–9 view switch --------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= roleViews.length) {
        setView(roleViews[n - 1]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [roleViews]);

  // --- Command palette actions ----------------------------------------------
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const acts: PaletteAction[] = roleViews.map((v, i) => ({
      id: `view:${v}`,
      group: "VIEWS",
      label: `GO TO ${v.toUpperCase()}`,
      hint: String(i + 1),
      run: () => setView(v),
    }));
    for (const a of agents) {
      acts.push({
        id: `agent:${a.id}`,
        group: "CHANNELS",
        label: `OPEN CHANNEL · ${a.name.toUpperCase()}`,
        hint: a.model,
        keywords: "agent chat talk",
        run: () => {
          setSelectedAgent(a.id);
          setView("command");
        },
      });
    }
    if (canBuild) {
      for (const w of workflows) {
        acts.push({
          id: `wf:${w.id}`,
          group: "WORKFLOWS",
          label: `OPEN CANVAS · ${w.name.toUpperCase()}`,
          hint: `v${w.currentVersion}`,
          keywords: "workflow edit graph",
          run: () => {
            setSelected(w.id);
            setView("canvas");
          },
        });
      }
      acts.push(
        { id: "sys:new-agent", group: "SYSTEM", label: "COMMISSION NEW AGENT", keywords: "create add", run: newAgent },
        { id: "sys:new-wf", group: "SYSTEM", label: "DRAFT NEW WORKFLOW", keywords: "create add", run: newWorkflow },
      );
    }
    // NEXUS tasks: every registry task is one palette order away (docs/NEXUS.md §3).
    for (const t of TASKS.filter((t) => !t.hidden && RANK[me.role] >= ROLE_RANK[t.minRole])) {
      acts.push({
        id: `task:${t.id}`,
        group: "TASKS",
        label: `TASK // ${t.title}`,
        hint: t.jumpOnly ? "PAGE" : "NEXUS",
        keywords: "nexus open task",
        run: () => {
          setView("nexus");
          setNexusSpawn({ task: t.id, n: ++spawnSeq.current });
        },
      });
    }
    acts.push({ id: "sys:signout", group: "SYSTEM", label: "SIGN OUT", keywords: "logout exit", run: onSignOut });
    return acts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleViews, agents, workflows, canBuild]);

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

  const idx = (id: string) => String(panelOrder.indexOf(id) + 1).padStart(2, "0");

  const sections: Record<string, () => JSX.Element | null> = {
    signal: () => (
      <section key="signal">
        <div className="panel-head">
          <span><span className="ph-idx">{idx("signal")}</span>SIGNAL</span>
          <span className="head-actions">
            <span className={`status ${connected ? "ok" : "down"}`}>{connected ? "LIVE" : "DOWN"}</span>
            {panelControls("signal")}
          </span>
        </div>
        {!collapsed.signal && <SignalRadar entries={signals} connected={connected} total={rxTotal} />}
      </section>
    ),
    list: () => {
      if (view === "canvas" && canBuild) {
        return (
          <section key="list">
            <div className="panel-head">
              <span><span className="ph-idx">{idx("list")}</span>WORKFLOWS</span>
              <span className="head-actions">
                {!collapsed.list && (
                  <>
                    <button className="chip tiny fui-chip" onClick={newWorkflow}>＋</button>
                    <button className="chip tiny fui-chip" onClick={sampleWorkflow}>SAMPLE</button>
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
            <span><span className="ph-idx">{idx("list")}</span>AGENTS</span>
            <span className="head-actions">
              {canBuild && !collapsed.list && <button className="chip tiny fui-chip" onClick={newAgent}>＋</button>}
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
          <span><span className="ph-idx">{idx("suggested")}</span>SUGGESTED</span>
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
          <span><span className="ph-idx">{idx("approvals")}</span>AUTHORIZATIONS</span>
          <span className="head-actions">
            <span className={`count ${approvals.length > 0 ? "hot" : ""}`}>{approvals.length}</span>
            {panelControls("approvals")}
          </span>
        </div>
        {!collapsed.approvals && (
          <ul className="appr-list">
            {approvals.length === 0 && <li className="muted pad">Inbox clear.</li>}
            {approvals.map((a) => (
              <li key={a.id} className="appr">
                <span className="appr-tag">PENDING · {a.tier.replace(/_/g, " ").toUpperCase()}</span>
                <div className="appr-prompt">{a.prompt}</div>
                {canBuild ? (
                  <div className="appr-actions">
                    <HoldButton tiny onComplete={() => decide(a.id, true)} title="Hold to authorize">
                      ⏣ HOLD TO AUTHORIZE
                    </HoldButton>
                    <button className="fui-chip tone-danger tiny" onClick={() => decide(a.id, false)}>DENY</button>
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

  const missionLive = mission !== null && ["queued", "running", "awaiting_approval"].includes(mission.status);

  return (
    <div className="app">
      <header className="rail">
        <span className="brand">
          {workspace?.branding?.brandName || "PUPPETMASTER"}
          <span className="brand-sub">{workspace?.name ? workspace.name.toUpperCase() : "COMMAND CENTER"}</span>
        </span>
        <nav className="view-switch" aria-label="Views">
          {roleViews.map((v, i) => (
            <button key={v} className={`vs ${view === v ? "on" : ""}`} onClick={() => setView(v)}>
              <span className="vs-idx">{String(i + 1).padStart(2, "0")}</span>
              {v.toUpperCase()}
            </button>
          ))}
        </nav>
        <span className="rail-meta">
          {info && <span className="tag-lo">DB {info.dbDriver.toUpperCase()} · Q {info.queue.toUpperCase()}</span>}
          <span className="user-chip" title={me.user.email}>
            {me.user.name.toUpperCase()} · {me.role.toUpperCase()}
          </span>
          <button className="fui-chip tiny" onClick={onSignOut}>SIGN OUT</button>
        </span>
      </header>

      <div className={`grid ${collapsed.trace ? "no-trace" : ""}`}>
        <aside className="panel side">
          {panelOrder.map((id) => sections[id]?.() ?? null)}
        </aside>

        <main className="panel canvas-panel">
          <div className="stage-head">
            <span className="stage-title">
              <span className="stage-idx">{String(roleViews.indexOf(view) + 1).padStart(2, "0")} //</span>
              <Decode text={view.toUpperCase()} />
            </span>
            <span className="stage-hint">
              <kbd>⌘K</kbd> COMMAND · <kbd>1–{roleViews.length}</kbd> VIEWS
            </span>
          </div>
          <div className="stage-body">
            {view === "nexus" && (
              <Nexus
                nx={{
                  role: me.role,
                  canBuild,
                  isAdmin: RANK[me.role] >= RANK.admin,
                  agents,
                  workflows,
                  approvals,
                  signals,
                  connected,
                  rxTotal,
                  navigate: (v) => setView(v as View),
                  track,
                  decide,
                  refreshAgents,
                  refreshWorkflows,
                }}
                spawn={nexusSpawn}
                reducedMotion={reducedMotion}
              />
            )}
            {view === "command" && (
              <Command agent={currentAgent} refreshKey={chatRefresh} onRan={track} streaming={streamText} />
            )}
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
            {view === "tools" && <ToolsView isAdmin={RANK[me.role] >= RANK.admin} />}
            {view === "evals" && RANK[me.role] >= RANK.admin && <EvalsView agents={agents} />}
            {view === "admin" && RANK[me.role] >= RANK.admin && (
              <AdminView
                meId={me.user.id}
                onBrandingChange={(ws) => {
                  setWorkspace(ws);
                  applyBranding(ws);
                }}
              />
            )}
          </div>
        </main>

        <aside className="panel trace">
          <div className="panel-head">
            <span><span className="ph-idx">OP</span>{collapsed.trace ? "TRACE" : "OPERATION"}</span>
            <span className="head-actions">
              {mission && !collapsed.trace && (
                <span className={`mstatus st-${mission.status}`}>
                  <Decode text={mission.status.replace(/_/g, " ").toUpperCase()} />
                </span>
              )}
              <button className="ph-btn" title={collapsed.trace ? "Expand" : "Collapse"} onClick={() => togglePanel("trace")}>
                {collapsed.trace ? "＋" : "－"}
              </button>
            </span>
          </div>
          {!collapsed.trace && (
            <>
              {mission?.parentMissionId && (
                <button className="fui-chip tiny parent-chip" onClick={() => track(mission.parentMissionId!)}>
                  ↑ NESTED · VIEW PARENT MISSION
                </button>
              )}
              {!mission && <p className="muted pad">Run a workflow or task an agent to open its dossier.</p>}
              {mission && canBuild && (
                <div className="trace-actions">
                  {missionLive && (
                    <button
                      className="fui-chip tiny"
                      onClick={() => api.cancelMission(mission.id).then(() => refreshTrace(mission.id)).catch(() => {})}
                    >
                      ✕ CANCEL
                    </button>
                  )}
                  {["failed", "cancelled"].includes(mission.status) && (
                    <button
                      className="fui-chip tiny"
                      onClick={() => api.retryMission(mission.id).then(() => refreshTrace(mission.id)).catch(() => {})}
                    >
                      ↻ RETRY
                    </button>
                  )}
                  {mission.status === "failed" && (
                    <button
                      className="fui-chip tiny"
                      onClick={() => api.explainMission(mission.id).then(setDiagnosis).catch(() => {})}
                    >
                      ? EXPLAIN
                    </button>
                  )}
                </div>
              )}
              {mission && (
                <TraceDossier
                  mission={mission}
                  steps={steps}
                  timing={timingRef.current[mission.id] ?? {}}
                  diagnosis={diagnosis}
                />
              )}
            </>
          )}
        </aside>
      </div>

      <SignalTicker entries={signals} total={rxTotal} connected={connected} sessionStart={sessionStart.current} />
      <Palette open={paletteOpen} actions={paletteActions} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}

