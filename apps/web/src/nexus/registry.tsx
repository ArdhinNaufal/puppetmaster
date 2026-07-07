import { useEffect, useMemo, useState, type JSX } from "react";
import { Chip, HoldButton, TierBadge } from "@puppetmaster/ui";
import {
  api,
  kbApi,
  opsApi,
  templateApi,
  type Agent,
  type Approval,
  type KbSearchHit,
  type Mission,
  type MissionStep,
  type Role,
  type Template,
  type Workflow,
} from "../api.js";
import { Command } from "../Command.js";
import { SignalRadar, type SignalEntry } from "../Signal.js";
import { TraceDossier } from "../Trace.js";

/**
 * NEXUS task registry (docs/NEXUS.md §4.2): the single source of truth for
 * every operator task on the page. The tray, the palette, and the Construct's
 * hit-targets all derive from this table. Rows with `jumpOnly` open their
 * dedicated view directly (in-pane bodies are P6 work, one row at a time).
 */

export const ROLE_RANK: Record<Role, number> = { member: 0, builder: 1, admin: 2, owner: 3 };

/** Everything a task body may need from the shell, injected by Nexus. */
export interface NX {
  role: Role;
  canBuild: boolean;
  isAdmin: boolean;
  agents: Agent[];
  workflows: Workflow[];
  approvals: Approval[];
  signals: SignalEntry[];
  connected: boolean;
  rxTotal: number;
  navigate: (view: string) => void;
  track: (missionId: string) => void;
  decide: (id: string, approved: boolean) => Promise<void>;
  openPane: (task: string, ctx?: Record<string, unknown>) => void;
  refreshAgents: () => void;
  refreshWorkflows: () => void;
}

export interface TaskDef {
  id: string;
  glyph: string;
  title: string;
  category: "OPERATE" | "OBSERVE" | "BUILD" | "GOVERN";
  minRole: Role;
  /** Shell view this task's full page lives in; null = live-only (no page). */
  jumpView: string | null;
  /** v0: no in-pane body yet — the tray/palette opens the full page. */
  jumpOnly?: boolean;
  /** Not listed in the tray (ceremony-only panes, e.g. the kernel snapshot). */
  hidden?: boolean;
  width?: number;
  body?: (props: { ctx: Record<string, unknown>; nx: NX }) => JSX.Element;
}

/* ------------------------------------------------------------- task bodies */

function AgentChannelBody({ ctx, nx }: { ctx: Record<string, unknown>; nx: NX }) {
  const [agentId, setAgentId] = useState<string>((ctx.agentId as string) ?? nx.agents[0]?.id ?? "");
  const agent = nx.agents.find((a) => a.id === agentId) ?? null;
  // Re-fetch the transcript whenever a persisted message lands for this agent.
  const refreshKey = useMemo(
    () => nx.signals.filter((s) => s.subject === agentId && s.type === "agent.message").length,
    [nx.signals, agentId],
  );
  return (
    <div className="nx-task-channel">
      <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent">
        {nx.agents.length === 0 && <option value="">— no agents —</option>}
        {nx.agents.map((a) => (
          <option key={a.id} value={a.id}>{a.name} · {a.model}</option>
        ))}
      </select>
      <div className="nx-channel-well">
        <Command agent={agent} refreshKey={refreshKey} onRan={nx.track} />
      </div>
    </div>
  );
}

function WorkflowRunBody({ ctx, nx }: { ctx: Record<string, unknown>; nx: NX }) {
  const [wfId, setWfId] = useState<string>((ctx.workflowId as string) ?? nx.workflows[0]?.id ?? "");
  const [input, setInput] = useState('{ "n": 10 }');
  const [msg, setMsg] = useState<string | null>(null);
  const [missionId, setMissionId] = useState<string | null>(null);

  const run = async () => {
    if (!wfId) return;
    let parsed: unknown = {};
    try {
      parsed = input.trim() ? JSON.parse(input) : {};
    } catch {
      setMsg("input is not valid JSON");
      return;
    }
    try {
      const r = await api.runWorkflow(wfId, parsed);
      setMissionId(r.missionId);
      nx.track(r.missionId);
      setMsg(`mission ${r.missionId.slice(0, 8)} launched`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "run failed");
    }
  };

  return (
    <div className="nx-task-stack">
      <select value={wfId} onChange={(e) => setWfId(e.target.value)} aria-label="Workflow">
        {nx.workflows.length === 0 && <option value="">— no workflows —</option>}
        {nx.workflows.map((w) => (
          <option key={w.id} value={w.id}>{w.name} · v{w.currentVersion}</option>
        ))}
      </select>
      <textarea
        className="text-input"
        rows={3}
        spellCheck={false}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        aria-label="Run input JSON"
      />
      <div className="nx-task-row">
        <Chip tone="accent" onClick={run} disabled={!wfId}>▶ LAUNCH</Chip>
        {missionId && (
          <Chip tiny onClick={() => nx.openPane("mission.dossier", { missionId })}>≡ OPEN DOSSIER</Chip>
        )}
        {msg && <span className="tb-msg">{msg}</span>}
      </div>
    </div>
  );
}

function AuthorizationsBody({ nx }: { ctx: Record<string, unknown>; nx: NX }) {
  return (
    <div className="nx-task-stack">
      {nx.approvals.length === 0 && <p className="dim">Inbox clear — nothing awaits authorization.</p>}
      <ul className="appr-list">
        {nx.approvals.map((a: Approval) => (
          <li key={a.id} className="appr">
            <span className="appr-tag">PENDING · {a.tier.replace(/_/g, " ").toUpperCase()}</span>
            <div className="appr-prompt">{a.prompt}</div>
            {nx.canBuild ? (
              <div className="appr-actions">
                <HoldButton tiny onComplete={() => nx.decide(a.id, true)} title="Hold to authorize">
                  ⏣ HOLD TO AUTHORIZE
                </HoldButton>
                <button className="fui-chip tone-danger tiny" onClick={() => nx.decide(a.id, false)}>DENY</button>
              </div>
            ) : (
              <div className="appr-actions"><span className="tag-lo">BUILDER+ ONLY</span></div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MissionDossierBody({ ctx, nx }: { ctx: Record<string, unknown>; nx: NX }) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [sel, setSel] = useState<string>((ctx.missionId as string) ?? "");
  const [detail, setDetail] = useState<{ mission: Mission; steps: MissionStep[] } | null>(null);
  const missionEvents = useMemo(
    () => nx.signals.filter((s) => s.type.startsWith("mission")).length,
    [nx.signals],
  );

  useEffect(() => {
    api.listMissions().then((ms) => {
      setMissions(ms);
      setSel((s) => s || ms[0]?.id || "");
    }).catch(() => {});
  }, [missionEvents]);

  useEffect(() => {
    if (!sel) return setDetail(null);
    api.getMission(sel).then(setDetail).catch(() => setDetail(null));
  }, [sel, missionEvents]);

  return (
    <div className="nx-task-stack">
      <select value={sel} onChange={(e) => setSel(e.target.value)} aria-label="Mission">
        {missions.slice(0, 25).map((m) => (
          <option key={m.id} value={m.id}>
            {m.kind.toUpperCase()} {m.id.slice(0, 8)} · {m.status.replace(/_/g, " ").toUpperCase()}
          </option>
        ))}
        {missions.length === 0 && <option value="">— no missions —</option>}
      </select>
      <div className="nx-dossier-well">
        {detail ? (
          <TraceDossier mission={detail.mission} steps={detail.steps} timing={{}} diagnosis={null} />
        ) : (
          <p className="dim pad">Select a mission.</p>
        )}
      </div>
    </div>
  );
}

function KnowledgeSearchBody(_: { ctx: Record<string, unknown>; nx: NX }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<KbSearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const search = () => {
    if (!q.trim()) return;
    kbApi.search(q, 6).then((h) => {
      setHits(h);
      setSearched(true);
    }).catch(() => setHits([]));
  };
  return (
    <div className="nx-task-stack">
      <div className="nx-task-row">
        <input
          className="text-input grow-input"
          placeholder="Ask the knowledge base…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <Chip onClick={search}>⌕</Chip>
      </div>
      <ul className="tool-list nx-scroll">
        {hits.map((h) => (
          <li key={h.chunkId} className="tool-row">
            <div className="tool-row-head">
              <span className="tool-name">{h.citation}</span>
              <span className="tag-lo">{h.score.toFixed(3)}</span>
            </div>
            <p className="tool-desc">{h.content.slice(0, 200)}{h.content.length > 200 ? "…" : ""}</p>
          </li>
        ))}
        {searched && hits.length === 0 && <li className="dim pad">No matches.</li>}
      </ul>
    </div>
  );
}

function ToolCatalogBody({ ctx }: { ctx: Record<string, unknown>; nx: NX }) {
  const [tools, setTools] = useState<{ server: string; tool: string; description?: string; tier?: string }[]>([]);
  const filter = ctx.server as string | undefined;
  useEffect(() => {
    api.tools().then((t) => setTools(t as typeof tools)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const list = filter ? tools.filter((t) => t.server === filter) : tools;
  return (
    <div className="nx-task-stack">
      {filter && <span className="tag-lo">NAMESPACE // {filter.toUpperCase()}</span>}
      <ul className="tool-list nx-scroll">
        {list.map((t) => (
          <li key={`${t.server}.${t.tool}`} className="tool-row">
            <div className="tool-row-head">
              <span className="tool-name">{t.server}.{t.tool}</span>
              {t.tier && <TierBadge tier={t.tier} />}
            </div>
            {t.description && <p className="tool-desc">{t.description.slice(0, 140)}</p>}
          </li>
        ))}
        {list.length === 0 && <li className="dim pad">No tools in catalog.</li>}
      </ul>
    </div>
  );
}

function TemplatesBody({ nx }: { ctx: Record<string, unknown>; nx: NX }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    templateApi.list().then(setTemplates).catch(() => {});
  }, []);
  const use = async (t: Template) => {
    try {
      const r = await templateApi.instantiate(t.id);
      setMsg(`created ${r.kind} from “${t.name}”`);
      if (r.kind === "agent") {
        nx.refreshAgents();
        nx.openPane("agent.channel", { agentId: r.id });
      } else {
        nx.refreshWorkflows();
        nx.openPane("workflow.run", { workflowId: r.id });
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "instantiate failed");
    }
  };
  return (
    <div className="nx-task-stack">
      {msg && <span className="tb-msg">{msg}</span>}
      <ul className="tool-list nx-scroll">
        {templates.map((t) => (
          <li key={t.id} className="tool-row">
            <div className="tool-row-head">
              <span className="tool-name">{t.name}</span>
              {nx.canBuild ? (
                <Chip tiny tone="accent" onClick={() => use(t)}>USE</Chip>
              ) : (
                <span className="tag-lo">BUILDER+</span>
              )}
            </div>
            <p className="tool-desc">{t.kind.toUpperCase()} · {t.description.slice(0, 120)}</p>
          </li>
        ))}
        {templates.length === 0 && <li className="dim pad">No templates.</li>}
      </ul>
    </div>
  );
}

function SignalFeedBody({ nx }: { ctx: Record<string, unknown>; nx: NX }) {
  return (
    <div className="nx-task-stack">
      <SignalRadar entries={nx.signals} connected={nx.connected} total={nx.rxTotal} />
      <ul className="nx-sig-list nx-scroll">
        {nx.signals.slice(0, 14).map((s) => (
          <li key={s.seq} className={`sig-entry tone-${s.tone}`}>
            <span className="sig-t">{new Date(s.at).toISOString().slice(11, 19)}</span> {s.label}
          </li>
        ))}
        {nx.signals.length === 0 && <li className="dim">No traffic yet.</li>}
      </ul>
    </div>
  );
}

function SnapshotBody({ nx }: { ctx: Record<string, unknown>; nx: NX }) {
  const [tokens, setTokens] = useState<number | null>(null);
  const [docs, setDocs] = useState<number | null>(null);
  const [tools, setTools] = useState<number | null>(null);
  useEffect(() => {
    opsApi.usage().then((u) => setTokens(u.monthTokens)).catch(() => setTokens(null));
    kbApi.list().then((d) => setDocs(d.length)).catch(() => setDocs(null));
    api.tools().then((t) => setTools(t.length)).catch(() => setTools(null));
  }, []);
  const row = (k: string, v: string, tone?: string) => (
    <div className="nx-snap-row">
      <span>{k}</span>
      <b className={tone}>{v}</b>
    </div>
  );
  return (
    <div className="nx-task-stack nx-snapshot">
      {row("LINK // BUS", nx.connected ? "ONLINE" : "DOWN", nx.connected ? "ok" : "err")}
      {row("AGENTS", String(nx.agents.length))}
      {row("WORKFLOWS", String(nx.workflows.length))}
      {row("KNOWLEDGE DOCS", docs === null ? "—" : String(docs))}
      {row("TOOLS IN CATALOG", tools === null ? "—" : String(tools))}
      {row("AUTHORIZATIONS PENDING", String(nx.approvals.length), nx.approvals.length ? "warn" : undefined)}
      {row("RX THIS SESSION", String(nx.rxTotal))}
      {row("TOKENS THIS MONTH", tokens === null ? "—" : tokens.toLocaleString())}
    </div>
  );
}

/* ---------------------------------------------------------------- registry */

export const TASKS: TaskDef[] = [
  { id: "agent.channel", glyph: "◉", title: "AGENT CHANNEL", category: "OPERATE", minRole: "member", jumpView: "command", width: 420, body: AgentChannelBody },
  { id: "workflow.run", glyph: "▶", title: "RUN WORKFLOW", category: "OPERATE", minRole: "member", jumpView: "missions", width: 380, body: WorkflowRunBody },
  { id: "authorizations", glyph: "⚑", title: "AUTHORIZATIONS", category: "OPERATE", minRole: "member", jumpView: "missions", width: 380, body: AuthorizationsBody },
  { id: "mission.dossier", glyph: "≡", title: "MISSION DOSSIER", category: "OBSERVE", minRole: "member", jumpView: "missions", width: 400, body: MissionDossierBody },
  { id: "knowledge.search", glyph: "⌕", title: "KNOWLEDGE SEARCH", category: "OPERATE", minRole: "member", jumpView: "knowledge", width: 400, body: KnowledgeSearchBody },
  { id: "tools.catalog", glyph: "⚙", title: "TOOL CATALOG", category: "OBSERVE", minRole: "member", jumpView: "tools", width: 400, body: ToolCatalogBody },
  { id: "template.use", glyph: "▤", title: "TEMPLATES", category: "BUILD", minRole: "member", jumpView: "templates", width: 400, body: TemplatesBody },
  { id: "signal.feed", glyph: "⊚", title: "SIGNAL FEED", category: "OBSERVE", minRole: "member", jumpView: null, width: 360, body: SignalFeedBody },
  { id: "system.snapshot", glyph: "⏣", title: "SYSTEM SNAPSHOT", category: "OBSERVE", minRole: "member", jumpView: null, width: 340, hidden: true, body: SnapshotBody },
  // P6: convert these to live pane bodies, one row per commit (docs/NEXUS.md §10).
  { id: "workshop", glyph: "⚒", title: "WORKSHOP", category: "BUILD", minRole: "member", jumpView: "workshop", jumpOnly: true },
  { id: "knowledge.ingest", glyph: "⇪", title: "INGEST DOCUMENT", category: "BUILD", minRole: "builder", jumpView: "knowledge", jumpOnly: true },
  { id: "evals.run", glyph: "✓", title: "EVAL SUITE", category: "GOVERN", minRole: "admin", jumpView: "evals", jumpOnly: true },
  { id: "budgets", glyph: "¤", title: "BUDGETS & USAGE", category: "GOVERN", minRole: "admin", jumpView: "evals", jumpOnly: true },
  { id: "router", glyph: "⇌", title: "MODEL ROUTER", category: "GOVERN", minRole: "admin", jumpView: "evals", jumpOnly: true },
  { id: "mcp.add", glyph: "＋", title: "ADD MCP SERVER", category: "BUILD", minRole: "admin", jumpView: "tools", jumpOnly: true },
  { id: "members", glyph: "⚇", title: "MEMBERS & ROLES", category: "GOVERN", minRole: "admin", jumpView: "admin", jumpOnly: true },
  { id: "branding", glyph: "◧", title: "BRANDING", category: "GOVERN", minRole: "admin", jumpView: "admin", jumpOnly: true },
  { id: "audit", glyph: "☰", title: "AUDIT LOG", category: "GOVERN", minRole: "admin", jumpView: "admin", jumpOnly: true },
];

export const taskById = (id: string): TaskDef | undefined => TASKS.find((t) => t.id === id);
