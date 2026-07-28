import { useEffect, useRef, useState } from "react";
import { Chip, Gauge, Panel, Stat, StatusDot, StatusText, TierBadge } from "@puppetmaster/ui";
import {
  agentApi,
  api,
  auditApi,
  kbApi,
  mcpApi,
  memberApi,
  opsApi,
  projectApi,
  routerApi,
  templateApi,
  workspaceApi,
  type Agent,
  type AgentMemory,
  type AuditEntry,
  type Budget,
  type CostClass,
  type EvalRun,
  type KbDocument,
  type KbSearchHit,
  type McpRegistryEntry,
  type McpServerRow,
  type MemberRow,
  type MemoryHit,
  type Mission,
  type Project,
  type ProjectArtifact,
  type ProjectTraceLink,
  type Role,
  type RouterProfile,
  type SpecCoverage,
  type Template,
  type TraceRefType,
  type TraceRelation,
  type UsageReport,
  type VerifyCheckRow,
  type Workflow,
  type Workspace,
} from "./api.js";
import { pdfToText, type PdfTextFormat } from "./pdf.js";

/* ---------------------------------------------------------------- Missions */

function durationMs(m: Mission): number | null {
  if (!m.startedAt) return null;
  const end = m.finishedAt ? new Date(m.finishedAt).getTime() : Date.now();
  return end - new Date(m.startedAt).getTime();
}

function fmtDuration(m: Mission): string {
  const ms = durationMs(m);
  if (ms === null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function MissionsView(props: {
  selected: string | null;
  onSelect: (missionId: string) => void;
  refreshKey: number;
}) {
  const [missions, setMissions] = useState<Mission[]>([]);

  useEffect(() => {
    api.listMissions().then(setMissions).catch(() => {});
  }, [props.refreshKey]);

  const counts = {
    running: missions.filter((m) => m.status === "running").length,
    gated: missions.filter((m) => m.status === "awaiting_approval").length,
    failed: missions.filter((m) => m.status === "failed").length,
    succeeded: missions.filter((m) => m.status === "succeeded").length,
  };
  const settled = counts.succeeded + counts.failed;
  const successPct = settled > 0 ? Math.round((counts.succeeded / settled) * 100) : null;

  // Tempo: durations of the most recent finished missions, oldest → newest.
  const finished = missions.filter((m) => m.startedAt && m.finishedAt);
  const tempo = finished.slice(0, 24).reverse().map((m) => (durationMs(m) ?? 0) / 1000);
  const maxDur = finished.reduce((mx, m) => Math.max(mx, durationMs(m) ?? 0), 0);

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="MISSIONS" value={missions.length} /></Panel>
        <Panel><Stat label="RUNNING" value={counts.running} tone={counts.running ? "accent" : "default"} /></Panel>
        <Panel><Stat label="AWAITING AUTH" value={counts.gated} tone={counts.gated ? "warn" : "default"} /></Panel>
        <Panel><Stat label="FAILED" value={counts.failed} tone={counts.failed ? "danger" : "default"} /></Panel>
        <Panel>
          <Stat
            label={tempo.length > 1 ? `SUCCESS · TEMPO (LAST ${tempo.length})` : "SUCCESS RATE"}
            value={successPct !== null ? `${successPct}%` : "—"}
            tone={successPct === null ? "default" : successPct >= 90 ? "ok" : successPct >= 60 ? "warn" : "danger"}
            spark={tempo.length > 1 ? tempo : undefined}
          />
        </Panel>
      </div>
      <Panel title="MISSION LOG" index="01" className="grow" scroll>
        <table className="fui-table">
          <thead>
            <tr><th></th><th>KIND</th><th>MISSION</th><th>STATUS</th><th>T-START</th><th>DURATION</th><th>NESTED</th></tr>
          </thead>
          <tbody>
            {missions.map((m) => {
              const ms = durationMs(m);
              return (
                <tr
                  key={m.id}
                  className={props.selected === m.id ? "sel" : ""}
                  onClick={() => props.onSelect(m.id)}
                >
                  <td><StatusDot status={m.status} pulse={m.status === "running"} /></td>
                  <td className="dim">{m.kind.toUpperCase()}</td>
                  <td className="mono">{m.id.slice(0, 8)}</td>
                  <td><StatusText status={m.status} /></td>
                  <td className="dim mono">
                    {m.startedAt ? new Date(m.startedAt).toISOString().slice(11, 19) : "—"}
                  </td>
                  <td>
                    <span className="dur-cell">
                      {ms !== null && maxDur > 0 && (
                        <span
                          className="dur-bar"
                          style={{ width: `${Math.max((Math.min(ms, maxDur) / maxDur) * 56, 2)}px` }}
                          aria-hidden="true"
                        />
                      )}
                      <span className="dim">{fmtDuration(m)}</span>
                    </span>
                  </td>
                  <td className="dim">{m.parentMissionId ? `↳ ${m.parentMissionId.slice(0, 8)}` : ""}</td>
                </tr>
              );
            })}
            {missions.length === 0 && (
              <tr><td colSpan={7} className="dim pad">No missions yet — run a workflow or chat with an agent.</td></tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ Agents */

export function AgentsView(props: {
  agents: Agent[];
  onOpenChat: (agentId: string) => void;
  onRemoved?: (agentId: string) => void;
  onUpdated?: () => void;
  readOnly?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [memQuery, setMemQuery] = useState("");
  const [memHits, setMemHits] = useState<MemoryHit[] | null>(null);
  const [saving, setSaving] = useState(false);

  const agent = props.agents.find((a) => a.id === selected) ?? null;

  useEffect(() => {
    if (selected && !props.agents.some((a) => a.id === selected)) {
      setSelected(null);
      setMemories([]);
    }
  }, [props.agents, selected]);

  useEffect(() => {
    setMemQuery("");
    setMemHits(null);
    if (selected) agentApi.memories(selected).then(setMemories).catch(() => setMemories([]));
  }, [selected]);

  const runMemSearch = async () => {
    if (!selected) return;
    const q = memQuery.trim();
    if (!q) {
      setMemHits(null);
      return;
    }
    setMemHits(await agentApi.searchMemories(selected, q).catch(() => []));
  };

  const patch = async (p: Record<string, unknown>) => {
    if (!agent || props.readOnly) return;
    setSaving(true);
    await fetch(`/api/agents/${agent.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    });
    props.onUpdated?.();
    setSaving(false);
  };

  const remove = async () => {
    if (!agent || props.readOnly) return;
    if (!confirm(`Delete agent "${agent.name}"?`)) return;
    setSaving(true);
    try {
      await agentApi.remove(agent.id);
      if (props.onRemoved) props.onRemoved(agent.id);
      else props.onUpdated?.();
      setSelected(null);
      setMemories([]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="view-wrap cols">
      <Panel title="AGENT ROSTER" index="01" className="w-roster" scroll>
        <div className="agent-cards">
          {props.agents.map((a) => (
            <button key={a.id} className={`agent-card ${selected === a.id ? "sel" : ""}`} onClick={() => setSelected(a.id)}>
              <span className="agent-ring">◉</span>
              <span className="agent-card-name">{a.name}</span>
              <span className="agent-card-meta">{a.model}</span>
              <TierBadge tier={a.autonomy} />
            </button>
          ))}
          {props.agents.length === 0 && <p className="dim pad">No agents. Create one from the Command view.</p>}
        </div>
      </Panel>
      <Panel title={agent ? `INSPECTOR · ${agent.name.toUpperCase()}` : "INSPECTOR"} index="02" className="grow" scroll
        actions={agent ? (
          <>
            <Chip tiny tone="accent" onClick={() => props.onOpenChat(agent.id)}>OPEN CHANNEL</Chip>
            {!props.readOnly && <Chip tiny tone="danger" onClick={() => void remove()}>DELETE</Chip>}
          </>
        ) : undefined}
      >
        {!agent && <p className="dim pad">Select an agent to inspect its definition, scratchpad, and memory.</p>}
        {agent && props.readOnly && (
          <p className="dim pad">Read-only — editing agent definitions requires the builder role.</p>
        )}
        {agent && (
          <div className={`inspector-grid ${props.readOnly ? "readonly" : ""}`}>
            <label className="ins-field">
              <span>Persona</span>
              <textarea
                key={agent.id}
                rows={4}
                defaultValue={agent.persona}
                onBlur={(e) => e.target.value !== agent.persona && patch({ persona: e.target.value })}
              />
            </label>
            <div className="ins-row">
              <label className="ins-field">
                <span>Model</span>
                <input key={agent.id + "m"} defaultValue={agent.model} onBlur={(e) => e.target.value !== agent.model && patch({ model: e.target.value })} />
              </label>
              <label className="ins-field">
                <span>Autonomy</span>
                <select value={agent.autonomy} onChange={(e) => patch({ autonomy: e.target.value })}>
                  <option value="read_auto">read_auto</option>
                  <option value="write_approved">write_approved</option>
                  <option value="destructive_confirmed">destructive_confirmed</option>
                </select>
              </label>
              <label className="ins-field">
                <span>Cron schedule</span>
                <input key={agent.id + "s"} defaultValue={agent.schedule ?? ""} placeholder="e.g. 0 9 * * 1-5"
                  onBlur={(e) => (e.target.value || null) !== agent.schedule && patch({ schedule: e.target.value || null })} />
              </label>
              <label className="ins-field">
                <span>Context compaction</span>
                <select
                  value={agent.contextCompaction ? "on" : "off"}
                  onChange={(e) => patch({ contextCompaction: e.target.value === "on" })}
                >
                  <option value="off">off (raw tool results)</option>
                  <option value="on">on (compact large results)</option>
                </select>
              </label>
            </div>
            <label className="ins-field">
              <span>Tool grants (comma-separated; empty = full catalog)</span>
              <input
                key={agent.id + "g"}
                defaultValue={(agent as unknown as { toolGrants?: string[] }).toolGrants?.join(", ") ?? ""}
                placeholder='util.echo, workflow.*'
                onBlur={(e) =>
                  patch({ toolGrants: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })
                }
              />
            </label>
            <div className="ins-cols">
              <div>
                <h3 className="ins-h">SCRATCHPAD</h3>
                <pre className="ins-pre">{JSON.stringify(agent.scratchpad ?? {}, null, 2)}</pre>
              </div>
              <div>
                <h3 className="ins-h">LONG-TERM MEMORY ({memories.length})</h3>
                <div className="mem-search">
                  <input
                    placeholder="Semantic recall…"
                    value={memQuery}
                    onChange={(e) => setMemQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && runMemSearch()}
                  />
                  <Chip tiny tone="accent" onClick={runMemSearch}>SEARCH</Chip>
                  {memHits !== null && (
                    <Chip tiny onClick={() => { setMemQuery(""); setMemHits(null); }}>CLEAR</Chip>
                  )}
                </div>
                {memHits !== null ? (
                  <>
                    {memHits.length === 0 && <p className="dim">No matches.</p>}
                    <ul className="mem-list">
                      {memHits.map((m) => (
                        <li key={m.id}>
                          {m.score !== null && <span className="mem-score">{m.score.toFixed(2)}</span>}
                          {m.content}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <>
                    {memories.length === 0 && <p className="dim">Nothing remembered yet.</p>}
                    <ul className="mem-list">
                      {memories.map((m) => (
                        <li key={m.id}>
                          <span className="tag-lo">{(m.kind ?? "fact").toUpperCase()}</span>{" "}
                          {m.pinned && <span title="pinned">📌</span>} {m.content}
                          {!props.readOnly && agent && (
                            <span style={{ marginLeft: 6, whiteSpace: "nowrap" }}>
                              <button
                                className="chip tiny"
                                title={m.pinned ? "Unpin (eligible for decay eviction)" : "Pin (never evicted)"}
                                onClick={() =>
                                  agentApi
                                    .updateMemory(agent.id, m.id, { pinned: !m.pinned })
                                    .then(() => agentApi.memories(agent.id).then(setMemories))
                                }
                              >
                                {m.pinned ? "UNPIN" : "PIN"}
                              </button>{" "}
                              <button
                                className="chip tiny"
                                onClick={() => {
                                  const next = prompt("Edit memory", m.content);
                                  if (next !== null && next.trim() && next !== m.content) {
                                    agentApi
                                      .updateMemory(agent.id, m.id, { content: next.trim() })
                                      .then(() => agentApi.memories(agent.id).then(setMemories));
                                  }
                                }}
                              >
                                EDIT
                              </button>{" "}
                              <button
                                className="chip tiny"
                                onClick={() =>
                                  agentApi
                                    .deleteMemory(agent.id, m.id)
                                    .then(() => agentApi.memories(agent.id).then(setMemories))
                                }
                              >
                                ✕
                              </button>
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </div>
            {saving && <span className="dim">saving…</span>}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------- Tools */

interface ToolInfo {
  server: string;
  tool: string;
  description: string;
  tier: string;
}

export function ToolsView(props: { isAdmin?: boolean; onChanged?: () => void }) {
  const [toolsList, setToolsList] = useState<ToolInfo[]>([]);
  const [mcpRows, setMcpRows] = useState<McpServerRow[]>([]);
  const [regQuery, setRegQuery] = useState("");
  const [regResults, setRegResults] = useState<McpRegistryEntry[] | null>(null);
  const [regError, setRegError] = useState("");
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = () => {
    api.tools().then((t) => setToolsList(t as ToolInfo[])).catch(() => {});
    if (props.isAdmin) mcpApi.list().then(setMcpRows).catch(() => {});
  };
  useEffect(refresh, [props.isAdmin]);

  const addServer = async (name: string, url: string) => {
    if (!name.trim() || !url.trim()) return;
    const res = await mcpApi.add({ name: name.trim().replace(/[^\w-]+/g, "-").slice(0, 40), url: url.trim() }).catch((e) => ({ connected: false, error: String(e) }) as { connected: boolean; error?: string });
    setNotice(res.connected ? `connected (${(res as { toolCount?: number }).toolCount ?? 0} tools)` : `saved but not connected: ${res.error ?? "connect failed"}`);
    refresh();
    props.onChanged?.();
  };

  const searchRegistry = async () => {
    setRegError("");
    try {
      const { servers } = await mcpApi.registry(regQuery);
      setRegResults(servers);
    } catch (e) {
      setRegResults([]);
      setRegError(e instanceof Error ? e.message : "registry unreachable");
    }
  };

  const servers = [...new Set(toolsList.map((t) => t.server))];

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="MCP SERVERS / NAMESPACES" value={servers.length} tone="accent" /></Panel>
        <Panel><Stat label="TOOLS IN CATALOG" value={toolsList.length} /></Panel>
      </div>
      {props.isAdmin && (
        <div className="tool-grid">
          <Panel title="WORKSPACE MCP SERVERS (streamable HTTP / stdio)" index="01" scroll>
            <div className="pad" style={{ display: "flex", gap: 8 }}>
              <input className="text-input" placeholder="name" value={addName}
                onChange={(e) => setAddName(e.target.value)} style={{ width: 120 }} />
              <input className="text-input" placeholder="https://example.com/mcp" value={addUrl}
                onChange={(e) => setAddUrl(e.target.value)} style={{ flex: 1 }} />
              <button className="chip" onClick={() => addServer(addName, addUrl)}>ADD</button>
            </div>
            {notice && <p className="dim pad">{notice}</p>}
            <ul className="tool-list">
              {mcpRows.map((r) => (
                <li key={r.id} className="tool-row">
                  <div className="tool-row-head">
                    <span className="tool-name">{r.name} · {r.transport.toUpperCase()}</span>
                    <span className="tag-lo">{r.connected ? `${r.toolCount} TOOLS` : "OFFLINE"}</span>
                  </div>
                  <p className="tool-desc">
                    {r.url ?? r.command}{" "}
                    <button className="chip tiny" onClick={() => mcpApi.remove(r.id).then(() => { refresh(); props.onChanged?.(); })}>REMOVE</button>
                  </p>
                </li>
              ))}
              {mcpRows.length === 0 && <li className="dim pad">No workspace MCP servers — add one or search the registry.</li>}
            </ul>
          </Panel>
          <Panel title="MCP REGISTRY" index="02" scroll>
            <div className="pad" style={{ display: "flex", gap: 8 }}>
              <input className="text-input" placeholder="Search the public registry…" value={regQuery}
                onChange={(e) => setRegQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && searchRegistry()} style={{ flex: 1 }} />
              <button className="chip" onClick={searchRegistry}>SEARCH</button>
            </div>
            {regError && <p className="dim pad">{regError}</p>}
            <ul className="tool-list">
              {(regResults ?? []).map((r, i) => (
                <li key={i} className="tool-row">
                  <div className="tool-row-head">
                    <span className="tool-name">{r.name}</span>
                    {r.remoteUrl ? (
                      <button className="chip tiny"
                        onClick={() => addServer(r.name.split("/").pop() ?? r.name, r.remoteUrl!)}>
                        + ADD
                      </button>
                    ) : (
                      <span className="tag-lo">NO REMOTE</span>
                    )}
                  </div>
                  <p className="tool-desc">{r.description.slice(0, 160)}</p>
                </li>
              ))}
              {regResults !== null && regResults.length === 0 && !regError && <li className="dim pad">No results.</li>}
            </ul>
          </Panel>
        </div>
      )}
      <div className="tool-grid">
        {servers.map((server) => (
          <Panel key={server} title={server.toUpperCase()} scroll>
            <ul className="tool-list">
              {toolsList
                .filter((t) => t.server === server)
                .map((t) => (
                  <li key={t.tool} className="tool-row">
                    <div className="tool-row-head">
                      <span className="tool-name">{server}.{t.tool}</span>
                      <TierBadge tier={t.tier} />
                    </div>
                    <p className="tool-desc">{t.description}</p>
                  </li>
                ))}
            </ul>
          </Panel>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Templates */

export function TemplatesView(props: {
  canBuild: boolean;
  agents: Agent[];
  workflows: Workflow[];
  onInstantiated: (kind: "workflow" | "agent", id: string) => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [pubRef, setPubRef] = useState("");
  const [pubName, setPubName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => templateApi.list().then(setTemplates).catch(() => {});
  useEffect(() => {
    refresh();
  }, [props.canBuild]);

  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2000);
  };

  const instantiate = async (t: Template) => {
    try {
      const r = await templateApi.instantiate(t.id);
      flash(`Created ${r.kind} from “${t.name}”`);
      props.onInstantiated(r.kind, r.id);
    } catch (err) {
      flash(err instanceof Error ? err.message : "instantiate failed");
    }
  };

  const remove = async (t: Template) => {
    if (!confirm(`Delete template “${t.name}”?`)) return;
    await templateApi.remove(t.id).catch(() => {});
    refresh();
  };

  const publish = async () => {
    if (!pubRef) return;
    const [kind, sourceId] = pubRef.split(":") as ["workflow" | "agent", string];
    try {
      await templateApi.publish({ kind, sourceId, name: pubName.trim() || undefined });
      setPubRef("");
      setPubName("");
      flash("Published to the workspace catalog");
      refresh();
    } catch (err) {
      flash(err instanceof Error ? err.message : "publish failed");
    }
  };

  const groups: { kind: "workflow" | "agent"; title: string }[] = [
    { kind: "workflow", title: "WORKFLOW TEMPLATES" },
    { kind: "agent", title: "AGENT TEMPLATES" },
  ];

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="TEMPLATES" value={templates.length} tone="accent" /></Panel>
        <Panel><Stat label="FIRST-PARTY" value={templates.filter((t) => t.builtin).length} /></Panel>
        <Panel><Stat label="PUBLISHED" value={templates.filter((t) => !t.builtin).length} /></Panel>
      </div>

      {props.canBuild && (
        <Panel title="PUBLISH A TEMPLATE" index="01" actions={msg ? <span className="dim">{msg}</span> : undefined}>
          <div className="ins-row pad">
            <label className="ins-field">
              <span>Source workflow or agent</span>
              <select value={pubRef} onChange={(e) => setPubRef(e.target.value)}>
                <option value="">— select —</option>
                {props.workflows.length > 0 && (
                  <optgroup label="Workflows">
                    {props.workflows.map((w) => <option key={w.id} value={`workflow:${w.id}`}>{w.name}</option>)}
                  </optgroup>
                )}
                {props.agents.length > 0 && (
                  <optgroup label="Agents">
                    {props.agents.map((a) => <option key={a.id} value={`agent:${a.id}`}>{a.name}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
            <label className="ins-field">
              <span>Template name (optional)</span>
              <input value={pubName} onChange={(e) => setPubName(e.target.value)} placeholder="defaults to source name" />
            </label>
            <Chip tone="accent" onClick={publish}>PUBLISH</Chip>
          </div>
        </Panel>
      )}

      <div className="templates-grid">
        {groups.map((g) => (
          <Panel key={g.kind} title={g.title} className="template-pane" scroll>
            <div className="tpl-cards">
              {templates.filter((t) => t.kind === g.kind).map((t) => (
                <div key={t.id} className="tpl-card">
                  <div className="tpl-head">
                    <span className="tpl-name">{t.name}</span>
                    <span className={`tpl-tag ${t.builtin ? "builtin" : "pub"}`}>
                      {t.builtin ? "FIRST-PARTY" : "PUBLISHED"}
                    </span>
                  </div>
                  <Chip tiny>{t.category}</Chip>
                  <p className="tpl-desc">{t.description}</p>
                  <div className="tpl-actions">
                    {props.canBuild ? (
                      <Chip tiny tone="accent" onClick={() => instantiate(t)}>USE THIS</Chip>
                    ) : (
                      <span className="tag-lo">BUILDER+ TO USE</span>
                    )}
                    {props.canBuild && !t.builtin && (
                      <Chip tiny tone="danger" onClick={() => remove(t)}>DELETE</Chip>
                    )}
                  </div>
                </div>
              ))}
              {templates.filter((t) => t.kind === g.kind).length === 0 && (
                <p className="dim pad">No {g.kind} templates.</p>
              )}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- Admin */

const ASSIGNABLE_ROLES: Role[] = ["admin", "builder", "member"];

export function AdminView(props: { meId: string; onBrandingChange: (ws: Workspace) => void }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [memberErr, setMemberErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ email: "", name: "", password: "", role: "member" as Role });
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState("");

  const refreshMembers = () => memberApi.list().then(setMembers).catch(() => {});
  const refreshAudit = (action?: string) => auditApi.list(action || undefined).then(setAudit).catch(() => {});
  useEffect(() => {
    workspaceApi.get().then(setWs).catch(() => {});
    refreshMembers();
    refreshAudit();
  }, []);

  const addMember = async () => {
    setMemberErr(null);
    try {
      await memberApi.create(draft);
      setDraft({ email: "", name: "", password: "", role: "member" });
      await refreshMembers();
    } catch (err) {
      setMemberErr(err instanceof Error ? err.message : "failed to add member");
    }
  };

  const setRole = async (userId: string, role: Role) => {
    setMemberErr(null);
    try {
      await memberApi.setRole(userId, role);
      await refreshMembers();
    } catch (err) {
      setMemberErr(err instanceof Error ? err.message : "failed to change role");
      await refreshMembers();
    }
  };

  const removeMember = async (userId: string, email: string) => {
    if (!confirm(`Remove ${email} from the workspace?`)) return;
    setMemberErr(null);
    try {
      await memberApi.remove(userId);
      await refreshMembers();
    } catch (err) {
      setMemberErr(err instanceof Error ? err.message : "failed to remove member");
    }
  };

  const save = async (patch: { name?: string; branding?: Workspace["branding"] }) => {
    const updated = await workspaceApi.update(patch);
    setWs(updated);
    props.onBrandingChange(updated);
    setMsg("saved");
    setTimeout(() => setMsg(null), 1500);
  };

  if (!ws) return <div className="view-wrap"><p className="dim pad">Loading workspace…</p></div>;

  return (
    <div className="view-wrap">
      <Panel title="WORKSPACE BRANDING" index="01" actions={msg ? <span className="dim">{msg}</span> : undefined}>
        <div className="inspector-grid pad">
          <div className="ins-row">
            <label className="ins-field">
              <span>Workspace name</span>
              <input defaultValue={ws.name} onBlur={(e) => e.target.value !== ws.name && save({ name: e.target.value })} />
            </label>
            <label className="ins-field">
              <span>Brand name (rail)</span>
              <input
                defaultValue={ws.branding.brandName ?? ""}
                placeholder="PUPPETMASTER"
                onBlur={(e) => save({ branding: { ...ws.branding, brandName: e.target.value || undefined } })}
              />
            </label>
            <label className="ins-field">
              <span>Accent hue</span>
              <input
                type="color"
                defaultValue={ws.branding.accent ?? "#f4f4f0"}
                onChange={(e) => save({ branding: { ...ws.branding, accent: e.target.value } })}
              />
            </label>
          </div>
          <p className="dim">
            Branding is workspace-scoped white-labelling (PRD §6): the accent hue and brand name skin
            the shell for every member.
          </p>
        </div>
      </Panel>

      <Panel title={`MEMBERS · ${members.length}`} index="02" className="grow" scroll
        actions={memberErr ? <span className="login-error">▲ {memberErr}</span> : undefined}
      >
        <table className="fui-table">
          <thead>
            <tr><th>NAME</th><th>EMAIL</th><th>ROLE</th><th></th></tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <td>{m.name}{m.userId === props.meId && <span className="dim"> · YOU</span>}</td>
                <td className="dim">{m.email}</td>
                <td>
                  {m.role === "owner" || m.userId === props.meId ? (
                    <span className={`role-badge r-${m.role}`}>{m.role.toUpperCase()}</span>
                  ) : (
                    <select value={m.role} onChange={(e) => setRole(m.userId, e.target.value as Role)}>
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  {m.role !== "owner" && m.userId !== props.meId && (
                    <Chip tiny tone="danger" onClick={() => removeMember(m.userId, m.email)}>REMOVE</Chip>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="member-add">
          <span className="tag-lo">ADD MEMBER</span>
          <div className="ins-row">
            <label className="ins-field"><span>Name</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="ins-field"><span>Email</span>
              <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
            </label>
            <label className="ins-field"><span>Password (8+)</span>
              <input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
            </label>
            <label className="ins-field"><span>Role</span>
              <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value as Role })}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <Chip tone="accent" onClick={addMember}>CREATE</Chip>
          </div>
          <p className="dim">
            Roles gate the gateway (RBAC): <b>member</b> observes and chats, <b>builder</b> authors and
            approves, <b>admin</b> manages members and branding, <b>owner</b> is fixed at setup.
          </p>
        </div>
      </Panel>

      <Panel
        title="AUDIT LOG"
        index="03"
        className="grow"
        scroll
        actions={
          <span className="head-actions">
            <select className="audit-filter" value={auditFilter} onChange={(e) => { setAuditFilter(e.target.value); refreshAudit(e.target.value); }}>
              <option value="">all actions</option>
              <option value="llm.call">llm.call</option>
              <option value="tool.call">tool.call</option>
              <option value="approval.requested">approval.requested</option>
              <option value="approval.decision">approval.decision</option>
              <option value="mission.finished">mission.finished</option>
              <option value="member.create">member.create</option>
              <option value="member.role">member.role</option>
              <option value="auth.login">auth.login</option>
            </select>
            <Chip tiny onClick={() => refreshAudit(auditFilter)}>REFRESH</Chip>
          </span>
        }
      >
        <table className="fui-table audit-table">
          <thead>
            <tr><th>TIME</th><th>ACTOR</th><th>ACTION</th><th>TARGET</th></tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td className="dim mono">{new Date(a.createdAt).toLocaleTimeString()}</td>
                <td><span className={`audit-actor ak-${a.actorKind}`}>{a.actorKind}</span> {a.actorLabel}</td>
                <td className="mono">{a.action}</td>
                <td className="dim">{a.target ?? ""}</td>
              </tr>
            ))}
            {audit.length === 0 && (
              <tr><td colSpan={4} className="dim pad">No audit entries yet.</td></tr>
            )}
          </tbody>
        </table>
        <p className="dim pad">
          Append-only trail (ARCHITECTURE §3.6): every LLM call, tool call, and approval decision,
          plus auth and membership changes.
        </p>
      </Panel>
    </div>
  );
}

/* --------------------------------------------------------------- Knowledge */

/** KNOWLEDGE view (Stage 3): upload md/txt/PDF documents, browse them, and
 *  search-test the same hybrid retrieval the kb.search tool uses. */
type KnowledgeUploadStatus =
  | { kind: "idle"; message: string }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string }
  | { kind: "progress"; message: string; progress: number };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateKnowledgeFile(file: File): string | null {
  if (!file.name.trim()) return "The selected file needs a filename.";
  if (file.size <= 0) return "The selected file is empty.";
  const name = file.name.toLowerCase();
  const supportedByName = /\.(md|txt|markdown|pdf)$/i.test(name);
  const supportedByMime = file.type === "application/pdf" || file.type === "text/plain" || file.type === "text/markdown";
  if (!supportedByName && !supportedByMime) {
    return "Unsupported file type. Use .md, .txt, .markdown, or .pdf.";
  }
  return null;
}

function readTextFile(file: File, onProgress?: (loaded: number, total: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read this file."));
    reader.onabort = () => reject(new Error("File read was cancelled."));
    reader.onprogress = (event) => {
      const total = event.total || file.size;
      if (event.lengthComputable || total > 0) onProgress?.(event.loaded, total);
    };
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read this file."));
    };
    reader.readAsText(file);
  });
}

function readArrayBufferFile(file: File, onProgress?: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read this file."));
    reader.onabort = () => reject(new Error("File read was cancelled."));
    reader.onprogress = (event) => {
      const total = event.total || file.size;
      if (event.lengthComputable || total > 0) onProgress?.(event.loaded, total);
    };
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("Could not read this file."));
    };
    reader.readAsArrayBuffer(file);
  });
}

function progressPercent(loaded: number, total: number, start = 0, end = 100): number {
  if (total <= 0) return end;
  const pct = start + Math.round((loaded / total) * (end - start));
  return Math.max(start, Math.min(end, pct));
}

export function KnowledgeView(props: { canBuild: boolean; onChanged?: () => void }) {
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [hits, setHits] = useState<KbSearchHit[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("");
  const [mime, setMime] = useState("text/markdown");
  const [pdfFormat, setPdfFormat] = useState<PdfTextFormat>("markdown");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [fileStatus, setFileStatus] = useState<KnowledgeUploadStatus>({
    kind: "idle",
    message: "Accepted: .md, .txt, .markdown, or .pdf. PDFs are parsed locally before ingest.",
  });

  const refresh = () => kbApi.list().then(setDocs).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const upload = async () => {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await kbApi.upload({
        title: title.trim(),
        content,
        source: source || undefined,
        mime,
      });
      setNotice(`Ingested "${res.document.title}" — ${res.chunkCount} chunks, ${res.embedded} embedded.`);
      setTitle("");
      setContent("");
      setSource("");
      setMime("text/markdown");
      setPdfFile(null);
      setSelectedFile(null);
      setFileStatus({
        kind: "ok",
        message: `Document "${res.document.title}" is saved and ready for search.`,
      });
      refresh();
      props.onChanged?.();
    } catch {
      setNotice("Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    setBusy(true);
    setNotice("");
    const validationError = validateKnowledgeFile(file);
    if (validationError) {
      setBusy(false);
      setPdfFile(null);
      setSelectedFile(null);
      setContent("");
      setSource("");
      setFileStatus({ kind: "error", message: validationError });
      return;
    }

    setSource(file.name);
    setSelectedFile(file);
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    setPdfFile(isPdf ? file : null);
    try {
      setFileStatus({
        kind: "progress",
        message: isPdf ? `Reading ${file.name}...` : `Reading ${file.name}...`,
        progress: 0,
      });
      const text = isPdf
        ? await (async () => {
            const buffer = await readArrayBufferFile(file, (loaded, total) => {
              setFileStatus({
                kind: "progress",
                message: `Reading ${file.name}...`,
                progress: progressPercent(loaded, total, 0, 45),
              });
            });
            setFileStatus({
              kind: "progress",
              message: `Parsing ${file.name} as ${pdfFormat}...`,
              progress: 45,
            });
            return pdfToText(buffer, pdfFormat, (page, totalPages) => {
              const parsed = totalPages > 0 ? page / totalPages : 1;
              setFileStatus({
                kind: "progress",
                message: totalPages > 0
                  ? `Parsing ${file.name} as ${pdfFormat}... (${page}/${totalPages} pages)`
                  : `Parsing ${file.name} as ${pdfFormat}...`,
                progress: 45 + Math.round(parsed * 55),
              });
            });
          })()
        : await readTextFile(file, (loaded, total) => {
            setFileStatus({
              kind: "progress",
              message: `Reading ${file.name}...`,
              progress: progressPercent(loaded, total, 0, 100),
            });
          });
      setContent(text);
      setMime(isPdf ? (pdfFormat === "markdown" ? "text/markdown" : "text/plain") : (file.type || "text/plain"));
      if (!title.trim()) setTitle(file.name.replace(/\.(md|txt|markdown|pdf)$/i, ""));
      setFileStatus({
        kind: "ok",
        message: isPdf
          ? `Parsed ${file.name} as ${pdfFormat}. Review the extracted text, then ingest it.`
          : `Loaded ${file.name}. Review the content, then ingest it.`,
      });
    } catch (error) {
      setContent("");
      setPdfFile(null);
      setFileStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not parse this file.",
      });
    } finally {
      setBusy(false);
    }
  };

  const changePdfFormat = async (format: PdfTextFormat) => {
    setPdfFormat(format);
    if (!pdfFile) return;
    setBusy(true);
    try {
      setFileStatus({
        kind: "progress",
        message: `Re-parsing ${pdfFile.name} as ${format}...`,
        progress: 0,
      });
      setContent(await pdfToText(pdfFile, format, (page, totalPages) => {
        const parsed = totalPages > 0 ? page / totalPages : 1;
        setFileStatus({
          kind: "progress",
          message: totalPages > 0
            ? `Re-parsing ${pdfFile.name} as ${format}... (${page}/${totalPages} pages)`
            : `Re-parsing ${pdfFile.name} as ${format}...`,
          progress: Math.round(parsed * 100),
        });
      }));
      setMime(format === "markdown" ? "text/markdown" : "text/plain");
      setFileStatus({
        kind: "ok",
        message: `Parsed ${pdfFile.name} as ${format}. Review the extracted text, then ingest it.`,
      });
    } catch (error) {
      setFileStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not parse this PDF.",
      });
    } finally {
      setBusy(false);
    }
  };

  const search = () => {
    if (!query.trim()) return setHits([]);
    kbApi.search(query, 8).then(setHits).catch(() => setHits([]));
  };

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="DOCUMENTS" value={docs.length} tone="accent" /></Panel>
        <Panel><Stat label="CHUNKS" value={docs.reduce((a, d) => a + d.chunkCount, 0)} /></Panel>
      </div>

      <div className="tool-grid">
        <Panel title="SEARCH TEST" index="01" scroll>
          <div className="pad" style={{ display: "flex", gap: 8 }}>
            <input
              className="text-input"
              placeholder="Ask the knowledge base…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              style={{ flex: 1 }}
            />
            <button className="chip" onClick={search}>SEARCH</button>
          </div>
          <ul className="tool-list">
            {hits.map((h) => (
              <li key={h.chunkId} className="tool-row">
                <div className="tool-row-head">
                  <span className="tool-name">{h.citation}</span>
                  <span className="tag-lo">{h.score.toFixed(3)}</span>
                </div>
                <p className="tool-desc">{h.content.slice(0, 280)}{h.content.length > 280 ? "…" : ""}</p>
              </li>
            ))}
            {hits.length === 0 && query && <li className="dim pad">No matches.</li>}
          </ul>
        </Panel>

        <Panel title="DOCUMENTS" index="02" scroll>
          <ul className="tool-list">
            {docs.map((d) => (
              <li key={d.id} className="tool-row">
                <div className="tool-row-head">
                  <span className="tool-name">{d.title}</span>
                  <span className="tag-lo">{d.chunkCount} CHUNKS</span>
                </div>
                <p className="tool-desc">
                  {d.source || d.mime} · {new Date(d.createdAt).toLocaleString()}
                  {props.canBuild && (
                    <>
                      {" "}
                      <button
                        className="chip tiny"
                        onClick={() => kbApi.remove(d.id).then(() => { refresh(); props.onChanged?.(); })}
                      >
                        DELETE
                      </button>
                    </>
                  )}
                </p>
              </li>
            ))}
            {docs.length === 0 && <li className="dim pad">No documents yet — upload md/txt to give agents a knowledge base.</li>}
          </ul>
        </Panel>

        {props.canBuild && (
          <Panel title="UPLOAD" index="03" scroll>
            <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                className="text-input"
                placeholder="Document title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <input
                type="file"
                accept=".md,.txt,.markdown,.pdf,application/pdf,text/plain,text/markdown"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />
              <div className="knowledge-upload-meta" aria-live="polite">
                <p className={`knowledge-upload-status ${fileStatus.kind}`}>
                  {fileStatus.kind === "error" ? "▲ " : fileStatus.kind === "ok" ? "● " : fileStatus.kind === "progress" ? "… " : ""}
                  {fileStatus.message}
                </p>
                {fileStatus.kind === "progress" && (
                  <div className="knowledge-progress" aria-label={fileStatus.message}>
                    <div className="knowledge-progress-track">
                      <div className="knowledge-progress-fill" style={{ width: `${fileStatus.progress}%` }} />
                    </div>
                    <span className="knowledge-progress-text">{fileStatus.progress}%</span>
                  </div>
                )}
                <p className="knowledge-upload-hint">
                  Accepted file types: .md, .txt, .markdown, .pdf. {fileStatus.kind === "ok" ? "Your text is ready to ingest." : "We validate the file before parsing."}
                </p>
                {source && (
                  <p className="knowledge-upload-file">
                    {source} · {selectedFile ? formatBytes(selectedFile.size) : "selected"} · {content.length.toLocaleString()} extracted characters
                  </p>
                )}
              </div>
              <label className="dim" htmlFor="knowledge-pdf-format">PDF extraction format</label>
              <select
                id="knowledge-pdf-format"
                className="text-input"
                value={pdfFormat}
                onChange={(e) => changePdfFormat(e.target.value as PdfTextFormat)}
              >
                <option value="markdown">Markdown (adds page headings)</option>
                <option value="text">Plain text</option>
              </select>
              <textarea
                className="text-input"
                rows={10}
                placeholder="…or paste markdown/plain text here"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
              <button className="chip" disabled={busy || !title.trim() || !content.trim()} onClick={upload}>
                {busy ? "INGESTING…" : "INGEST DOCUMENT"}
              </button>
              {notice && <p className="dim">{notice}</p>}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}


/* -------------------------------------------------------------- Workshop */

function checkConfigurationIssue(name: string, command: string | null | undefined): string | null {
  if (["test", "arch", "custom"].includes(name) && !command?.trim()) {
    return `${name} requires a shell command`;
  }
  if (name === "load") {
    if (!command?.trim()) return "load requires JSON with declared slos and a run command";
    try {
      const config = JSON.parse(command) as { slos?: unknown; run?: unknown };
      if (!Array.isArray(config.slos) || config.slos.length === 0) return "load requires at least one declared SLO";
      if (typeof config.run !== "string" || !config.run.trim()) return "load requires a run command";
    } catch {
      return "load configuration must be valid JSON";
    }
  }
  return null;
}

/** WORKSHOP view (AI-SDLC plan WP7a): projects + their artifact sets and
 *  verify checks. Phase-flow actions (interview, execute) arrive with WP5's
 *  remaining increments; this surface reads and manages what WP2/WP4 built. */
export function WorkshopView(props: { canBuild: boolean; isAdmin: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [checks, setChecks] = useState<VerifyCheckRow[]>([]);
  const [coverage, setCoverage] = useState<SpecCoverage | null>(null);
  const [traceLinks, setTraceLinks] = useState<ProjectTraceLink[]>([]);
  const [reading, setReading] = useState<ProjectArtifact | null>(null);
  const [name, setName] = useState("");
  const [repoRef, setRepoRef] = useState("");
  const [gated, setGated] = useState(false);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadFailures, setLoadFailures] = useState<string[]>([]);
  const [artifactKind, setArtifactKind] = useState<ProjectArtifact["kind"]>("spec");
  const [artifactTitle, setArtifactTitle] = useState("");
  const [artifactBody, setArtifactBody] = useState("");
  const [artifactStatus, setArtifactStatus] = useState("backlog");
  const [revisionBase, setRevisionBase] = useState<ProjectArtifact | null>(null);
  const [writingArtifact, setWritingArtifact] = useState(false);
  const [checkName, setCheckName] = useState("todo-sync");
  const [checkCommand, setCheckCommand] = useState("");
  const [creatingCheck, setCreatingCheck] = useState(false);
  const [earningCheckId, setEarningCheckId] = useState<string | null>(null);
  const [earningNote, setEarningNote] = useState("");
  const [earningCommand, setEarningCommand] = useState("");
  const [traceSource, setTraceSource] = useState("");
  const [traceTarget, setTraceTarget] = useState("");
  const [traceRelation, setTraceRelation] = useState<TraceRelation>("derives");
  const [traceRationale, setTraceRationale] = useState("");
  const [writingTrace, setWritingTrace] = useState(false);
  const [confirmDeleteLinkId, setConfirmDeleteLinkId] = useState<string | null>(null);
  const openSequence = useRef(0);

  const refresh = async () => {
    const next = await projectApi.list();
    setProjects(next);
    return next;
  };
  useEffect(() => {
    void refresh().catch(() => setNotice("Projects could not be loaded."));
  }, []);

  const open = async (p: Project) => {
    const sequence = ++openSequence.current;
    setSelected(p);
    setReading(null);
    setRevisionBase(null);
    setArtifacts([]);
    setChecks([]);
    setCoverage(null);
    setTraceLinks([]);
    setTraceSource("");
    setTraceTarget("");
    setTraceRationale("");
    setConfirmDeleteLinkId(null);
    setEarningCheckId(null);
    setEarningNote("");
    setEarningCommand("");
    setLoadFailures([]);
    setLoading(true);
    setNotice("");
    const results = await Promise.allSettled([
      projectApi.artifacts(p.id),
      projectApi.checks(p.id),
      projectApi.specCoverage(p.id),
      projectApi.traceLinks(p.id),
    ]);
    if (sequence !== openSequence.current) return;
    const [artifactResult, checkResult, coverageResult, traceResult] = results;
    setArtifacts(artifactResult.status === "fulfilled" ? artifactResult.value : []);
    setChecks(checkResult.status === "fulfilled" ? checkResult.value : []);
    setCoverage(coverageResult.status === "fulfilled" ? coverageResult.value : null);
    setTraceLinks(traceResult.status === "fulfilled" ? traceResult.value : []);
    setLoading(false);
    const failures = results
      .map((result, index) => result.status === "rejected" ? ["artifacts", "checks", "spec coverage", "trace links"][index]! : null)
      .filter((label): label is string => label !== null);
    setLoadFailures(failures);
    if (failures.length > 0) {
      setNotice(`${failures.join(", ")} could not be loaded. Retry by selecting the project again.`);
    }
    return failures;
  };

  const create = async () => {
    if (!name.trim()) return;
    try {
      const p = await projectApi.create({ name: name.trim(), repoRef: repoRef.trim(), mode: gated ? "gated" : "supervised" });
      setName("");
      setRepoRef("");
      setGated(false);
      await refresh();
      await open(p);
    } catch (err) {
      setNotice(`Create failed: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  };

  const toggleCheck = async (c: VerifyCheckRow, note = c.earnedNote, command = c.command ?? "") => {
    if (!props.isAdmin || !selected) return false;
    if (!c.enabled && !note.trim()) return false;
    if (!c.enabled && checkConfigurationIssue(c.name, command)) return false;
    try {
      await projectApi.updateCheck(selected.id, c.id, {
        enabled: !c.enabled,
        earnedNote: note,
        ...(command !== (c.command ?? "") ? { command } : {}),
      });
      await open(selected);
      return true;
    } catch (err) {
      setNotice(`Check update failed: ${err instanceof Error ? err.message : "unknown error"}`);
      return false;
    }
  };

  const writeArtifact = async () => {
    const kind = draftArtifactKind;
    const title = draftArtifactTitle.trim();
    if (!selected || !title || !artifactBody.trim()) return;
    setWritingArtifact(true);
    try {
      await projectApi.writeArtifact(selected.id, {
        kind,
        title,
        body: artifactBody.trim(),
        ...(kind === "todo" || kind === "adr" ? { status: artifactStatus } : {}),
      });
      setArtifactTitle("");
      setArtifactBody("");
      setRevisionBase(null);
      const failures = await open(selected);
      if (failures?.length === 0) {
        setNotice("Artifact recorded. New spec and plan versions require their trace links to be re-confirmed.");
      }
    } catch (err) {
      setNotice(`Artifact write failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setWritingArtifact(false);
    }
  };

  const createCheck = async () => {
    if (!selected || !props.isAdmin) return;
    const issue = checkConfigurationIssue(checkName, checkCommand);
    if (issue) {
      setNotice(`Check configuration is incomplete: ${issue}.`);
      return;
    }
    setCreatingCheck(true);
    try {
      await projectApi.createCheck(selected.id, {
        name: checkName,
        ...(checkCommand.trim() ? { command: checkCommand.trim() } : {}),
      });
      setCheckCommand("");
      const failures = await open(selected);
      if (failures?.length === 0) {
        setNotice("Check added in the disabled state. Enable it only when a real failure has earned the policy.");
      }
    } catch (err) {
      setNotice(`Check creation failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setCreatingCheck(false);
    }
  };

  const parseTraceRef = (value: string): { type: TraceRefType; id: string } | null => {
    const split = value.indexOf(":");
    if (split < 1) return null;
    const type = value.slice(0, split);
    if (type !== "artifact" && type !== "check") return null;
    return { type, id: value.slice(split + 1) };
  };

  const createTraceLink = async () => {
    if (!selected || !props.canBuild || !traceRationale.trim()) return;
    const source = parseTraceRef(traceSource);
    const target = parseTraceRef(traceTarget);
    if (!source || !target || (source.type === target.type && source.id === target.id)) return;
    const sequence = openSequence.current;
    setWritingTrace(true);
    try {
      const link = await projectApi.createTraceLink(selected.id, {
        sourceType: source.type,
        sourceId: source.id,
        targetType: target.type,
        targetId: target.id,
        relation: traceRelation,
        rationale: traceRationale.trim(),
      });
      if (sequence !== openSequence.current) return;
      setTraceLinks((current) => [...current, link]);
      setTraceSource("");
      setTraceTarget("");
      setTraceRationale("");
      setNotice("Trace link confirmed and added to the decision graph.");
    } catch (err) {
      if (sequence === openSequence.current) {
        setNotice(`Trace link failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    } finally {
      setWritingTrace(false);
    }
  };

  const deleteTraceLink = async (linkId: string) => {
    if (!selected || !props.canBuild) return;
    const sequence = openSequence.current;
    try {
      await projectApi.deleteTraceLink(selected.id, linkId);
      if (sequence !== openSequence.current) return;
      setTraceLinks((current) => current.filter((link) => link.id !== linkId));
      setConfirmDeleteLinkId(null);
      setNotice("Trace link removed. Review the resulting orphan warning before proceeding.");
    } catch (err) {
      if (sequence === openSequence.current) {
        setNotice(`Trace link removal failed: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
  };

  // Only current artifact versions drive readiness. Historical versions and
  // their links remain visible so a revision cannot silently inherit trust.
  const supersededIds = new Set(artifacts.map((artifact) => artifact.supersedesId).filter(Boolean));
  const currentArtifacts = artifacts.filter((artifact) => !supersededIds.has(artifact.id));
  const currentArtifactIds = new Set(currentArtifacts.map((artifact) => artifact.id));
  const currentCheckIds = new Set(checks.map((check) => check.id));
  const endpointIsCurrent = (type: TraceRefType, id: string) =>
    type === "artifact" ? currentArtifactIds.has(id) : currentCheckIds.has(id);
  const currentTraceLinks = traceLinks.filter(
    (link) => endpointIsCurrent(link.sourceType, link.sourceId) && endpointIsCurrent(link.targetType, link.targetId),
  );
  const todos = currentArtifacts.filter((artifact) => artifact.kind === "todo");
  const knowledgeHistory = artifacts
    .filter((artifact) => artifact.kind !== "todo")
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const newestOfKind = (kind: ProjectArtifact["kind"]) =>
    currentArtifacts
      .filter((artifact) => artifact.kind === kind)
      .reduce<ProjectArtifact | null>(
        (latest, artifact) => !latest || new Date(artifact.createdAt) > new Date(latest.createdAt) ? artifact : latest,
        null,
      );
  const latestSpec = coverage?.spec
    ? currentArtifacts.find((artifact) => artifact.id === coverage.spec?.id) ?? newestOfKind("spec")
    : newestOfKind("spec");
  const latestPlan = newestOfKind("plan");
  const openTodos = todos.filter((todo) => todo.status !== "completed");
  const enabledChecks = checks.filter((check) => check.enabled);
  const unrunnableChecks = enabledChecks.filter((check) => checkConfigurationIssue(check.name, check.command));

  const planHasUpstream = !latestPlan || Boolean(latestSpec && currentTraceLinks.some(
    (link) =>
      link.sourceType === "artifact" &&
      link.sourceId === latestSpec.id &&
      link.targetType === "artifact" &&
      link.targetId === latestPlan.id &&
      (link.relation === "derives" || link.relation === "informs"),
  ));
  const deliveryUpstreamIds = new Set([latestSpec?.id, latestPlan?.id].filter((id): id is string => Boolean(id)));
  const orphanTodos = openTodos.filter((todo) => !currentTraceLinks.some(
    (link) =>
      link.sourceType === "artifact" &&
      deliveryUpstreamIds.has(link.sourceId) &&
      link.targetType === "artifact" &&
      link.targetId === todo.id &&
      (link.relation === "derives" || link.relation === "informs"),
  ));
  const unlinkedChecks = enabledChecks.filter(
    (check) => !currentTraceLinks.some(
      (link) =>
        link.sourceType === "artifact" &&
        link.targetType === "check" &&
        link.targetId === check.id &&
        link.relation === "verifies",
    ),
  );
  const orphanCount = (planHasUpstream ? 0 : 1) + orphanTodos.length + unlinkedChecks.length;
  const specReady = Boolean(
    coverage?.spec && coverage.missing.length === 0 && coverage.thin.length === 0,
  );
  const planReady = Boolean(latestPlan && planHasUpstream);
  const todoReady = openTodos.length > 0 && orphanTodos.length === 0;
  const verifyReady = enabledChecks.length > 0 && unlinkedChecks.length === 0 && unrunnableChecks.length === 0;
  const artifactsAvailable = !loading && !loadFailures.includes("artifacts");
  const checksAvailable = !loading && !loadFailures.includes("checks");
  const coverageAvailable = !loading && !loadFailures.includes("spec coverage");
  const linksAvailable = !loading && !loadFailures.includes("trace links");
  const graphDataAvailable = artifactsAvailable && checksAvailable && linksAvailable;
  const readiness = [
    { label: "Concrete spec", ready: artifactsAvailable && coverageAvailable ? specReady : null },
    { label: "Plan retains spec context", ready: artifactsAvailable && linksAvailable ? planReady : null },
    { label: "Delivery todos are traced", ready: artifactsAvailable && linksAvailable ? todoReady : null },
    { label: "Verification intent is runnable + linked", ready: graphDataAvailable ? verifyReady : null },
  ];
  const traceSubjects = [
    ...(latestSpec ? [{ type: "artifact" as const, id: latestSpec.id, traced: currentTraceLinks.some((link) => link.sourceId === latestSpec.id || link.targetId === latestSpec.id) }] : []),
    ...(latestPlan ? [{ type: "artifact" as const, id: latestPlan.id, traced: planHasUpstream }] : []),
    ...openTodos.map((todo) => ({ type: "artifact" as const, id: todo.id, traced: !orphanTodos.some((orphan) => orphan.id === todo.id) })),
    ...enabledChecks.map((check) => ({ type: "check" as const, id: check.id, traced: !unlinkedChecks.some((unlinked) => unlinked.id === check.id) })),
  ];
  const traceDataAvailable = graphDataAvailable;
  const traceCoverage = traceDataAvailable && traceSubjects.length > 0
    ? Math.round((traceSubjects.filter((subject) => subject.traced).length / traceSubjects.length) * 100)
    : null;
  const nextMove = loading
    ? "Refreshing project evidence…"
    : loadFailures.length > 0
      ? `Retry before judging readiness: ${loadFailures.join(", ")} unavailable.`
    : !latestSpec
      ? "Capture a concrete spec before planning."
      : !specReady
        ? `Resolve ${coverage?.missing.length ?? 0} missing and ${coverage?.thin.length ?? 0} thin spec sections.`
        : !latestPlan
          ? "Create a delivery plan from the current spec."
          : !planHasUpstream
            ? "Re-confirm how the current plan derives from the current spec."
            : openTodos.length === 0
              ? "Decompose the plan into at least one delivery todo."
              : orphanTodos.length > 0
                ? `Restore upstream context for ${orphanTodos.length} orphaned todo${orphanTodos.length === 1 ? "" : "s"}.`
                : enabledChecks.length === 0
                  ? "Define and enable the checks that will prove the increment."
                  : unrunnableChecks.length > 0
                    ? `Fix configuration for ${unrunnableChecks.length} enabled check${unrunnableChecks.length === 1 ? "" : "s"}.`
                    : unlinkedChecks.length > 0
                    ? `Link ${unlinkedChecks.length} enabled check${unlinkedChecks.length === 1 ? "" : "s"} to what they verify.`
                    : "Ready for the next execution increment; keep the graph current as evidence changes.";

  const traceOptions = [
    ...currentArtifacts.map((artifact) => ({
      value: `artifact:${artifact.id}`,
      label: `${artifact.kind.toUpperCase()} · ${artifact.title}${artifact.version > 1 ? ` v${artifact.version}` : ""}`,
    })),
    ...checks.map((check) => ({
      value: `check:${check.id}`,
      label: `CHECK · ${check.name}${check.enabled ? " · enabled" : " · disabled"}`,
    })),
  ];
  const traceSourceOptions = traceRelation === "derives" || traceRelation === "verifies"
    ? traceOptions.filter((option) => option.value.startsWith("artifact:"))
    : traceOptions;
  const traceTargetOptions = traceRelation === "derives"
    ? traceOptions.filter((option) => option.value.startsWith("artifact:"))
    : traceRelation === "verifies"
      ? traceOptions.filter((option) => option.value.startsWith("check:"))
      : traceOptions;
  const refLabel = (type: TraceRefType, id: string) => {
    if (type === "artifact") {
      const artifact = artifacts.find((candidate) => candidate.id === id);
      return artifact
        ? `${artifact.kind.toUpperCase()} · ${artifact.title}${artifact.version > 1 ? ` v${artifact.version}` : ""}`
        : "ARTIFACT · removed";
    }
    const check = checks.find((candidate) => candidate.id === id);
    return check ? `CHECK · ${check.name}` : "CHECK · removed";
  };
  const availableArtifactKind = artifactKind === "spec" && latestSpec
    ? latestPlan ? "todo" : "plan"
    : artifactKind === "plan" && latestPlan
      ? "todo"
      : artifactKind;
  const draftArtifactKind = revisionBase?.kind ?? availableArtifactKind;
  const draftArtifactTitle = revisionBase?.title ?? artifactTitle;
  const draftCheckIssue = checkConfigurationIssue(checkName, checkCommand);
  const draftCheckHelp = draftCheckIssue ?? (
    ["todo-sync", "spec-sections"].includes(checkName)
      ? "This check is DB-native and needs no shell command."
      : checkName === "refactor-gate"
        ? "This check uses the workbench git diff and needs no custom command."
        : "Configuration is structurally runnable."
  );
  const PHASES = ["idle", "specify", "plan", "execute", "verify", "record"] as const;

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="PROJECTS" value={projects.length} tone="accent" /></Panel>
        <Panel><Stat label="PROJECT ACTIVE" value={todos.filter((t) => t.status === "active").length} /></Panel>
        <Panel><Stat label="PROJECT DONE" value={todos.filter((t) => t.status === "completed").length} /></Panel>
        <Panel><Stat label="PROJECT CHECKS" value={checks.filter((c) => c.enabled).length} /></Panel>
        <Panel><Stat label="TRACE COVERAGE" value={traceCoverage === null ? "—" : `${traceCoverage}%`} /></Panel>
      </div>

      <div className="tool-grid workshop-grid">
        <Panel title="PROJECTS" index="01" scroll className="workshop-projects-panel">
          <ul className="tool-list">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  className={`workshop-project-button ${selected?.id === p.id ? "sel" : ""}`}
                  aria-pressed={selected?.id === p.id}
                  onClick={() => void open(p)}
                >
                  <span className="tool-row-head">
                    <span className="tool-name">{selected?.id === p.id ? "▸ " : ""}{p.name}</span>
                    <span className="tag-lo">{p.mode.toUpperCase()} · {p.phase.toUpperCase()}</span>
                  </span>
                  {p.repoRef && <span className="tool-desc">{p.repoRef}</span>}
                </button>
              </li>
            ))}
            {projects.length === 0 && (
              <li className="dim pad">No projects yet — the Workshop is where software is built under verifiable gates.</li>
            )}
          </ul>
          {props.canBuild && (
            <div className="inspector-grid workshop-compose">
              <label className="ins-field"><span>Project name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="ins-field"><span>Repository reference</span>
                <input placeholder="optional until workbench attach" value={repoRef} onChange={(e) => setRepoRef(e.target.value)} />
              </label>
              <label className="tag-lo" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={gated} onChange={(e) => setGated(e.target.checked)} />
                GATED MODE (autonomous between verify gates — requires enabled checks to run)
              </label>
              <button className="chip" disabled={!name.trim()} onClick={() => void create()}>CREATE PROJECT</button>
            </div>
          )}
        </Panel>

        <Panel title={selected ? `DOSSIER · ${selected.name.toUpperCase()}` : "DOSSIER"} index="02" scroll className="workshop-dossier-panel">
          {!selected && <p className="dim pad">Select a project to inspect its phases, todos, and artifacts.</p>}
          {selected && (
            <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {PHASES.map((ph) => (
                  <span key={ph} className={ph === selected.phase ? "chip tiny" : "tag-lo"} style={{ padding: "2px 6px" }}>
                    {ph.toUpperCase()}
                  </span>
                ))}
              </div>
              <div className="workshop-next-card" aria-live="polite">
                <span className="tag-lo">ADVISORY READINESS · NEXT MOVE</span>
                <strong>{nextMove}</strong>
                <span className="dim">Guidance only; deterministic verify checks remain the execution gates.</span>
              </div>
              {loading && <p className="dim">Refreshing artifacts, checks, coverage, and trace links…</p>}
              {loadFailures.includes("artifacts") && <p className="dim warn-text">Artifacts are unavailable; lists and authoring are paused.</p>}
              {loadFailures.includes("spec coverage") && <p className="dim warn-text">Spec coverage is unavailable; readiness is unknown.</p>}
              {coverage && coverage.required.length > 0 && (
                <div>
                  <span className="tag-lo">
                    SPEC COVERAGE · {coverage.present.length}/{coverage.required.length} FILLED
                    {coverage.spec ? ` · ${coverage.spec.title} v${coverage.spec.version}` : " · NO SPEC YET"}
                  </span>
                  <div
                    className="cov-bar"
                    title={`${coverage.present.length} filled · ${coverage.thin.length} thin · ${coverage.missing.length} missing`}
                  >
                    <span className="cov-seg cov-ok" style={{ width: `${(coverage.present.length / coverage.required.length) * 100}%` }} />
                    <span className="cov-seg cov-thin" style={{ width: `${(coverage.thin.length / coverage.required.length) * 100}%` }} />
                  </div>
                  <ul className="tool-list">
                    {coverage.required.map((s) => {
                      const st = coverage.present.includes(s) ? "ok" : coverage.thin.includes(s) ? "thin" : "missing";
                      return (
                        <li key={s} className="cov-row">
                          <span className={`cov-mark cov-${st}`}>{st === "ok" ? "✓" : st === "thin" ? "~" : "○"}</span>
                          <span className="cov-name">{s}</span>
                          <span className="tag-lo">{st === "ok" ? "FILLED" : st === "thin" ? "THIN" : "MISSING"}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {(["active", "backlog", "completed"] as const).map((st) => (
                <div key={st}>
                  <span className="tag-lo">TODO · {st.toUpperCase()}</span>
                  <ul className="tool-list">
                    {todos.filter((t) => t.status === st).map((t) => (
                      <li key={t.id} className="tool-row">
                        <div className="tool-row-head">
                          <span className="tool-name">{t.title}</span>
                          {t.missionId && <span className="tag-lo" title={t.missionId}>MISSION-LINKED</span>}
                        </div>
                      </li>
                    ))}
                    {todos.filter((t) => t.status === st).length === 0 && <li className="dim pad">—</li>}
                  </ul>
                </div>
              ))}
              <span className="tag-lo">KNOWLEDGE ARTIFACTS</span>
              <ul className="tool-list">
                {knowledgeHistory.map((a) => (
                  <li key={a.id} className="workshop-artifact-row">
                    <button className="workshop-artifact-button" onClick={() => setReading(a)}>
                      <span className="tool-row-head">
                        <span className="tool-name">{a.title}</span>
                        <span className="tag-lo">
                          {a.kind.toUpperCase()} v{a.version}
                          {a.status ? ` · ${a.status.toUpperCase()}` : ""}
                          {currentArtifactIds.has(a.id) ? " · CURRENT" : " · HISTORY"}
                        </span>
                      </span>
                    </button>
                    {props.canBuild && currentArtifactIds.has(a.id) && (a.kind === "spec" || a.kind === "plan") && (
                      <button
                        className="chip tiny workshop-revise-button"
                        aria-label={`Create a new version of ${a.title}`}
                        onClick={() => {
                          setRevisionBase(a);
                          setArtifactKind(a.kind);
                          setArtifactTitle(a.title);
                          setArtifactBody("");
                          setReading(a);
                        }}
                      >
                        REVISE
                      </button>
                    )}
                  </li>
                ))}
                {knowledgeHistory.length === 0 && <li className="dim pad">No spec/plan/learnings/ADR artifacts yet.</li>}
              </ul>
              {reading && (
                <pre className="appr-evidence" style={{ maxHeight: 260, overflowY: "auto" }}>
                  {`${reading.kind.toUpperCase()} · ${reading.title} (v${reading.version})\n\n${reading.body || "(empty)"}`}
                </pre>
              )}
              {props.canBuild && artifactsAvailable && (
                <div className="inspector-grid workshop-compose">
                  <div>
                    <span className="tag-lo">{revisionBase ? `NEW VERSION · ${revisionBase.title} v${revisionBase.version + 1}` : "ADD ARTIFACT"}</span>
                    <p className="dim">
                      {revisionBase
                        ? "The artifact identity is locked. Its existing trace links remain historical and must be re-confirmed for this version."
                        : "Use REVISE on a current spec or plan to create a bound next version."}
                    </p>
                  </div>
                  <div className="ins-row">
                    <label className="ins-field"><span>Kind</span>
                      <select
                        value={draftArtifactKind}
                        disabled={revisionBase !== null}
                        onChange={(e) => {
                          const kind = e.target.value as ProjectArtifact["kind"];
                          setArtifactKind(kind);
                          setArtifactStatus(kind === "adr" ? "proposed" : "backlog");
                        }}
                      >
                        {!latestSpec && <option value="spec">spec (initial)</option>}
                        {!latestPlan && <option value="plan">plan (initial)</option>}
                        <option value="todo">todo</option>
                        <option value="learning">learning</option>
                        <option value="adr">ADR</option>
                      </select>
                    </label>
                    {(draftArtifactKind === "todo" || draftArtifactKind === "adr") && (
                      <label className="ins-field"><span>Status</span>
                        <select value={artifactStatus} onChange={(e) => setArtifactStatus(e.target.value)}>
                          {draftArtifactKind === "todo" ? (
                            <><option value="backlog">backlog</option><option value="active">active</option></>
                          ) : (
                            <><option value="proposed">proposed</option><option value="accepted">accepted</option></>
                          )}
                        </select>
                      </label>
                    )}
                  </div>
                  <label className="ins-field"><span>Title</span>
                    <input
                      value={draftArtifactTitle}
                      readOnly={revisionBase !== null}
                      onChange={(e) => setArtifactTitle(e.target.value)}
                    />
                  </label>
                  <label className="ins-field"><span>Body / evidence</span>
                    <textarea rows={6} value={artifactBody} onChange={(e) => setArtifactBody(e.target.value)} />
                  </label>
                  <button
                    className="chip"
                    disabled={writingArtifact || !draftArtifactTitle.trim() || !artifactBody.trim()}
                    onClick={() => void writeArtifact()}
                  >
                    {writingArtifact ? "RECORDING…" : revisionBase ? "RECORD NEW VERSION" : "RECORD ARTIFACT"}
                  </button>
                  {revisionBase && (
                    <button
                      className="chip"
                      onClick={() => {
                        setRevisionBase(null);
                        setArtifactTitle("");
                        setArtifactBody("");
                      }}
                    >
                      CANCEL REVISION
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </Panel>

        <Panel title="VERIFY CHECKS" index="03" scroll className="workshop-checks-panel">
          {!selected && <p className="dim pad">Checks are earned policies, per project — off by default.</p>}
          {selected && (
            <>
              {loadFailures.includes("checks") && <p className="dim pad warn-text">Checks are unavailable; configuration is paused.</p>}
              <ul className="tool-list">
                {checks.map((c) => (
                  <li key={c.id} className="tool-row">
                    <div className="tool-row-head">
                      <span className="tool-name">{c.name}</span>
                      <span className="tag-lo">
                        {c.enabled ? "ENABLED" : "DISABLED"}
                        {c.baseline !== null ? ` · BASELINE ${c.baseline}` : ""}
                      </span>
                    </div>
                    {c.command && <p className="tool-desc">command: {c.command}</p>}
                    {checkConfigurationIssue(c.name, c.command) && (
                      <p className="tool-desc warn-text">configuration: {checkConfigurationIssue(c.name, c.command)}</p>
                    )}
                    {c.earnedNote && <p className="tool-desc">earned: {c.earnedNote}</p>}
                    {props.isAdmin && c.enabled && (
                      <p className="tool-desc">
                        <button className="chip tiny" onClick={() => void toggleCheck(c)}>DISABLE</button>
                      </p>
                    )}
                    {props.isAdmin && !c.enabled && earningCheckId !== c.id && (
                      <p className="tool-desc">
                        <button
                          className="chip tiny"
                          onClick={() => {
                            setEarningCheckId(c.id);
                            setEarningNote(c.earnedNote);
                            setEarningCommand(c.command ?? "");
                          }}
                        >
                          ENABLE (EARN)
                        </button>
                      </p>
                    )}
                    {props.isAdmin && !c.enabled && earningCheckId === c.id && (
                      <div className="workshop-earn-check">
                        <label className="ins-field"><span>Failure that earned this policy</span>
                          <input value={earningNote} onChange={(e) => setEarningNote(e.target.value)} />
                        </label>
                        <label className="ins-field"><span>Command / configuration</span>
                          <input value={earningCommand} onChange={(e) => setEarningCommand(e.target.value)} />
                        </label>
                        {checkConfigurationIssue(c.name, earningCommand) && (
                          <p className="dim warn-text">{checkConfigurationIssue(c.name, earningCommand)}</p>
                        )}
                        <div className="ins-row">
                          <button
                            className="chip tiny"
                            disabled={!earningNote.trim() || Boolean(checkConfigurationIssue(c.name, earningCommand))}
                            onClick={() => void toggleCheck(c, earningNote, earningCommand).then((updated) => {
                              if (updated) {
                                setEarningCheckId(null);
                                setEarningNote("");
                                setEarningCommand("");
                              }
                            })}
                          >
                            CONFIRM ENABLE
                          </button>
                          <button
                            className="chip tiny"
                            onClick={() => {
                              setEarningCheckId(null);
                              setEarningCommand("");
                            }}
                          >
                            CANCEL
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
                {checks.length === 0 && <li className="dim pad">No checks configured. Gated mode refuses to run without one.</li>}
              </ul>
              {props.isAdmin && checksAvailable && (
                <div className="inspector-grid workshop-compose">
                  <span className="tag-lo">ADD DISABLED CHECK</span>
                  <label className="ins-field"><span>Check</span>
                    <select
                      value={checkName}
                      onChange={(e) => {
                        setCheckName(e.target.value);
                        setCheckCommand("");
                      }}
                    >
                      <option value="test">test</option>
                      <option value="arch">arch</option>
                      <option value="refactor-gate">refactor-gate</option>
                      <option value="todo-sync">todo-sync</option>
                      <option value="spec-sections">spec-sections</option>
                      <option value="load">load</option>
                      <option value="custom">custom</option>
                    </select>
                  </label>
                  <label className="ins-field"><span>Command / configuration</span>
                    <input
                      value={checkCommand}
                      placeholder={checkName === "load" ? '{"slos":[{"name":"p95_ms","max":200}],"run":"k6 run load.js"}' : "e.g. pnpm test"}
                      onChange={(e) => setCheckCommand(e.target.value)}
                    />
                  </label>
                  <p className={`dim ${draftCheckIssue ? "warn-text" : ""}`}>
                    {draftCheckHelp}
                  </p>
                  <button className="chip" disabled={creatingCheck || Boolean(draftCheckIssue)} onClick={() => void createCheck()}>
                    {creatingCheck ? "ADDING…" : "ADD CHECK"}
                  </button>
                </div>
              )}
            </>
          )}
        </Panel>

        <Panel title="DECISION GRAPH · TRACEABILITY" index="04" scroll className="workshop-trace-panel">
          {!selected && <p className="dim pad">Select a project to see how discovery, decisions, delivery, and verification connect.</p>}
          {selected && (
            <div className="workshop-trace pad">
              <div className="workshop-trace-summary">
                <div><span className="tag-lo">TRACE COVERAGE</span><strong>{traceCoverage === null ? "—" : `${traceCoverage}%`}</strong></div>
                <div><span className="tag-lo">CURRENT / TOTAL LINKS</span><strong>{traceDataAvailable ? `${currentTraceLinks.length}/${traceLinks.length}` : "—"}</strong></div>
                <div><span className="tag-lo">ORPHAN WARNINGS</span><strong className={traceDataAvailable && orphanCount > 0 ? "warn-text" : "ok-text"}>{traceDataAvailable ? orphanCount : "—"}</strong></div>
              </div>
              <div className="workshop-next-card">
                <span className="tag-lo">NEXT MOVE</span>
                <strong>{nextMove}</strong>
                <span className="dim">Readiness is advisory and human-reviewable; it does not replace the project’s earned verify gates.</span>
              </div>
              <ul className="workshop-readiness-list" aria-label="Advisory delivery readiness">
                {readiness.map((item) => (
                  <li key={item.label}>
                    <span className={item.ready === null ? "cov-mark" : item.ready ? "cov-mark cov-ok" : "cov-mark cov-missing"}>
                      {item.ready === null ? "?" : item.ready ? "✓" : "○"}
                    </span>
                    <span>{item.label}</span>
                    <span className="tag-lo">{item.ready === null ? "UNKNOWN" : item.ready ? "READY" : "OPEN"}</span>
                  </li>
                ))}
              </ul>

              <div>
                <span className="tag-lo">ORPHAN WATCH</span>
                <ul className="workshop-warning-list">
                  {!traceDataAvailable && <li>Trace links are unavailable; retry before treating any orphan count as evidence.</li>}
                  {traceDataAvailable && !planHasUpstream && latestPlan && <li>Current plan is not linked back to the current spec.</li>}
                  {traceDataAvailable && orphanTodos.map((todo) => <li key={todo.id}>TODO · {todo.title} has no upstream spec/plan context.</li>)}
                  {traceDataAvailable && unlinkedChecks.map((check) => <li key={check.id}>CHECK · {check.name} is enabled but not linked to what it verifies.</li>)}
                  {traceDataAvailable && unrunnableChecks.map((check) => (
                    <li key={`config-${check.id}`}>CHECK · {check.name} cannot run: {checkConfigurationIssue(check.name, check.command)}.</li>
                  ))}
                  {traceDataAvailable && orphanCount === 0 && traceSubjects.length > 0 && <li className="ok-text">No delivery or verification orphans detected.</li>}
                  {traceDataAvailable && traceSubjects.length === 0 && <li>Record a spec, plan, todo, or enabled check to start the decision graph.</li>}
                </ul>
              </div>

              <div>
                <span className="tag-lo">CONFIRMED REASONING CHAIN</span>
                <ul className="workshop-link-list">
                  {traceLinks.map((link) => {
                    const isCurrent = currentTraceLinks.some((candidate) => candidate.id === link.id);
                    const sourceLabel = refLabel(link.sourceType, link.sourceId);
                    const targetLabel = refLabel(link.targetType, link.targetId);
                    return (
                      <li key={link.id} className={isCurrent ? "" : "historical"}>
                        <div className="workshop-link-path">
                          <span>{sourceLabel}</span>
                          <b>{link.relation.toUpperCase()} →</b>
                          <span>{targetLabel}</span>
                        </div>
                        <span className="tag-lo">{isCurrent ? "CURRENT" : "HISTORICAL · EXCLUDED FROM READINESS"}</span>
                        <p>{link.rationale}</p>
                        {props.canBuild && confirmDeleteLinkId !== link.id && (
                          <button
                            className="chip tiny"
                            aria-label={`Remove trace link from ${sourceLabel} to ${targetLabel}`}
                            onClick={() => setConfirmDeleteLinkId(link.id)}
                          >
                            REMOVE LINK
                          </button>
                        )}
                        {props.canBuild && confirmDeleteLinkId === link.id && (
                          <div className="workshop-confirm-remove" role="group" aria-label={`Confirm removal of trace link from ${sourceLabel} to ${targetLabel}`}>
                            <span className="warn-text">This removes rationale-bearing history.</span>
                            <button className="chip tiny" onClick={() => void deleteTraceLink(link.id)}>CONFIRM REMOVE</button>
                            <button className="chip tiny" onClick={() => setConfirmDeleteLinkId(null)}>CANCEL</button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                  {traceDataAvailable && traceLinks.length === 0 && <li className="dim">No confirmed links yet. Flat artifacts lose the reasoning that produced them.</li>}
                  {!traceDataAvailable && <li className="dim">Confirmed links could not be loaded.</li>}
                </ul>
              </div>

              {props.canBuild && traceDataAvailable && (
                <div className="inspector-grid workshop-compose workshop-trace-compose">
                  <div>
                    <span className="tag-lo">CONFIRM A TRACE LINK</span>
                    <p className="dim">Link current artifacts and checks. A rationale is required so the edge remains reviewable.</p>
                  </div>
                  <div className="ins-row">
                    <label className="ins-field"><span>Source</span>
                      <select value={traceSource} onChange={(e) => setTraceSource(e.target.value)}>
                        <option value="">— select artifact or check —</option>
                        {traceSourceOptions.map((option) => <option key={`source-${option.value}`} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="ins-field"><span>Relationship</span>
                      <select
                        value={traceRelation}
                        onChange={(e) => {
                          setTraceRelation(e.target.value as TraceRelation);
                          setTraceSource("");
                          setTraceTarget("");
                        }}
                      >
                        <option value="informs">informs</option>
                        <option value="derives">derives</option>
                        <option value="verifies">verifies</option>
                        <option value="mitigates">mitigates</option>
                      </select>
                    </label>
                    <label className="ins-field"><span>Target</span>
                      <select value={traceTarget} onChange={(e) => setTraceTarget(e.target.value)}>
                        <option value="">— select artifact or check —</option>
                        {traceTargetOptions.map((option) => <option key={`target-${option.value}`} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="ins-field"><span>Rationale / evidence for this link</span>
                    <input value={traceRationale} onChange={(e) => setTraceRationale(e.target.value)} />
                  </label>
                  <button
                    className="chip"
                    disabled={
                      writingTrace ||
                      !traceSource ||
                      !traceTarget ||
                      traceSource === traceTarget ||
                      !traceRationale.trim()
                    }
                    onClick={() => void createTraceLink()}
                  >
                    {writingTrace ? "CONFIRMING…" : "CONFIRM LINK"}
                  </button>
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>
      {notice && <p className="workshop-notice" role="status">{notice}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------- Evals */

/** EVALS view (Stage 5): run the golden suite (pass^k, trajectory checks),
 *  browse past runs, and manage the cost ledger + monthly token budgets.
 *  Stage 9A adds the router-profiles panel (named fallback chains). */
export function EvalsView(props: { agents: Agent[] }) {
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [running, setRunning] = useState(false);
  const [limit, setLimit] = useState("");
  const [budgetAgent, setBudgetAgent] = useState("");
  const [profiles, setProfiles] = useState<RouterProfile[]>([]);
  const [costClasses, setCostClasses] = useState<CostClass[]>(["premium", "cheap", "local", "free"]);
  const [profName, setProfName] = useState("");
  const [profChain, setProfChain] = useState("");
  const [profFloor, setProfFloor] = useState("");

  const refresh = () => {
    opsApi.listEvals().then(setRuns).catch(() => {});
    opsApi.usage().then(setUsage).catch(() => {});
    opsApi.listBudgets().then(setBudgets).catch(() => {});
    routerApi
      .list()
      .then((r) => {
        setProfiles(r.profiles);
        setCostClasses(r.costClasses);
      })
      .catch(() => {});
  };
  useEffect(refresh, []);

  /** Chain syntax: `model@class | model@class` (class defaults to premium). */
  const addProfile = () => {
    const candidates = profChain
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((part) => {
        const [model, cls] = part.split("@").map((s) => s.trim());
        return { model: model ?? "", costClass: (cls || "premium") as CostClass };
      });
    if (!profName.trim() || candidates.length === 0) return;
    routerApi
      .create({
        name: profName.trim(),
        candidates,
        minClassForGatedTools: (profFloor || null) as CostClass | null,
      })
      .then(() => {
        setProfName("");
        setProfChain("");
        setProfFloor("");
        refresh();
      })
      .catch(() => {});
  };

  const run = async () => {
    setRunning(true);
    try {
      await opsApi.runEvals(3);
      refresh();
    } finally {
      setRunning(false);
    }
  };

  const agentName = (id: string | null) =>
    id ? (props.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8)) : "workspace";

  // Instruments: real measurements only. Budget burn renders when a
  // workspace-wide budget exists; pass rate when a suite has run.
  const wsBudget = budgets.find((b) => b.agentId === null) ?? null;
  const burn = wsBudget && usage ? usage.monthTokens / wsBudget.monthlyTokenLimit : null;

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="LAST SUITE" value={runs[0] ? `${runs[0].passed}/${runs[0].total}` : "—"} tone="accent" /></Panel>
        <Panel><Stat label="TOKENS THIS MONTH" value={(usage?.monthTokens ?? 0).toLocaleString()} unit="TOK" /></Panel>
        <Panel><Stat label="BUDGETS" value={budgets.length} /></Panel>
        <Panel><Stat label="TOKENS AVOIDED (9C)" value={(usage?.compaction?.tokensAvoided ?? 0).toLocaleString()} unit="TOK" /></Panel>
      </div>

      {(runs[0] || burn !== null) && (
        <Panel title="INSTRUMENTS" index="00">
          <div className="gauge-row pad">
            {runs[0] && (
              <Gauge
                label="SUITE PASS RATE"
                value={runs[0].passed}
                max={runs[0].total}
                display={`${runs[0].passed}/${runs[0].total}`}
                tone={runs[0].passed === runs[0].total ? "ok" : runs[0].passed === 0 ? "danger" : "warn"}
              />
            )}
            {burn !== null && usage && wsBudget && (
              <Gauge
                label="WS BUDGET BURN"
                value={usage.monthTokens}
                max={wsBudget.monthlyTokenLimit}
                display={usage.monthTokens >= 1000 ? `${Math.round(usage.monthTokens / 1000)}k` : String(usage.monthTokens)}
                tone={burn >= 1 ? "danger" : burn >= 0.8 ? "warn" : "default"}
              />
            )}
          </div>
        </Panel>
      )}

      <div className="tool-grid">
        <Panel title="GOLDEN SUITE (pass^3 + trajectory)" index="01" scroll
          actions={<Chip tiny tone="accent" onClick={run}>{running ? "RUNNING…" : "RUN SUITE"}</Chip>}>
          <ul className="tool-list">
            {runs.map((r) => (
              <li key={r.id} className="tool-row">
                <div className="tool-row-head">
                  <span className="tool-name">{r.passed}/{r.total} PASSED · k={r.k}</span>
                  <span className="tag-lo">{new Date(r.createdAt).toLocaleString()}</span>
                </div>
                {r.results.map((t) => (
                  <p key={t.id} className="tool-desc">
                    {t.pass ? "✅" : "❌"} {t.id} [{t.passes.map((p) => (p ? "✓" : "✗")).join("")}]
                    {!t.trajectoryOk && " · trajectory violation"}
                    {t.notes.length > 0 && ` — ${t.notes[0]}`}
                  </p>
                ))}
              </li>
            ))}
            {runs.length === 0 && <li className="dim pad">No eval runs yet.</li>}
          </ul>
        </Panel>

        <Panel title="COST LEDGER (MONTH TO DATE)" index="02" scroll>
          <ul className="tool-list">
            {(usage?.breakdown ?? []).map((row, i) => (
              <li key={i} className="tool-row">
                <div className="tool-row-head">
                  <span className="tool-name">{row.agentName ?? "system"} · {row.model || "?"}</span>
                  <span className="tag-lo">{row.inputTokens + row.outputTokens} TOK</span>
                </div>
                <p className="tool-desc">{row.calls} calls · {row.inputTokens} in / {row.outputTokens} out</p>
              </li>
            ))}
            {(usage?.breakdown ?? []).length === 0 && <li className="dim pad">No LLM usage recorded this month.</li>}
          </ul>
        </Panel>

        <Panel title="MONTHLY TOKEN BUDGETS" index="03" scroll>
          <div className="pad" style={{ display: "flex", gap: 8 }}>
            <select value={budgetAgent} onChange={(e) => setBudgetAgent(e.target.value)}>
              <option value="">whole workspace</option>
              {props.agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <input
              className="text-input"
              placeholder="token limit e.g. 100000"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              style={{ width: 160 }}
            />
            <button
              className="chip"
              onClick={() => {
                const n = Number(limit);
                if (Number.isFinite(n) && n > 0) {
                  opsApi.createBudget({ agentId: budgetAgent || null, monthlyTokenLimit: n }).then(() => {
                    setLimit("");
                    refresh();
                  });
                }
              }}
            >
              ADD BUDGET
            </button>
          </div>
          <ul className="tool-list">
            {budgets.map((b) => (
              <li key={b.id} className="tool-row">
                <div className="tool-row-head">
                  <span className="tool-name">{agentName(b.agentId)}</span>
                  <span className="tag-lo">{b.monthlyTokenLimit} TOK/MO</span>
                </div>
                <p className="tool-desc">
                  Exceeding this pauses new ticks behind an approval.{" "}
                  <button className="chip tiny" onClick={() => opsApi.deleteBudget(b.id).then(refresh)}>REMOVE</button>
                </p>
              </li>
            ))}
            {budgets.length === 0 && <li className="dim pad">No budgets — ticks run ungated.</li>}
          </ul>
        </Panel>

        <Panel title="ROUTER PROFILES (Stage 9A)" index="04" scroll>
          <div className="pad" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              className="text-input"
              placeholder="name e.g. quality-first"
              value={profName}
              onChange={(e) => setProfName(e.target.value)}
              style={{ width: 150 }}
            />
            <input
              className="text-input"
              placeholder="chain: claude-sonnet-5@premium | mock@free"
              value={profChain}
              onChange={(e) => setProfChain(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <select value={profFloor} onChange={(e) => setProfFloor(e.target.value)}>
              <option value="">no floor</option>
              {costClasses.map((c) => (
                <option key={c} value={c}>floor: {c}</option>
              ))}
            </select>
            <button className="chip" onClick={addProfile}>ADD PROFILE</button>
          </div>
          <ul className="tool-list">
            {profiles.map((p) => (
              <li key={p.id} className="tool-row">
                <div className="tool-row-head">
                  <span className="tool-name">profile:{p.name}{!p.enabled && " · DISABLED"}</span>
                  <span className="tag-lo">
                    {p.minClassForGatedTools ? `FLOOR ${p.minClassForGatedTools.toUpperCase()}` : "NO FLOOR"}
                  </span>
                </div>
                <p className="tool-desc">
                  {p.candidates.map((c) => `${c.model} (${c.costClass})`).join(" → ")}
                  {" · "}
                  <button className="chip tiny" onClick={() => routerApi.setEnabled(p.id, !p.enabled).then(refresh)}>
                    {p.enabled ? "DISABLE" : "ENABLE"}
                  </button>{" "}
                  <button className="chip tiny" onClick={() => routerApi.remove(p.id).then(refresh)}>REMOVE</button>
                </p>
              </li>
            ))}
            {profiles.length === 0 && (
              <li className="dim pad">
                No profiles — agents use raw model strings. Set an agent's model to
                {" "}profile:NAME to route through a profile.
              </li>
            )}
          </ul>
        </Panel>

        <Panel title="ROUTER HEALTH (Stage 9B)" index="05" scroll
          actions={<Chip tiny onClick={refresh}>REFRESH</Chip>}>
          <ul className="tool-list">
            {Object.entries(usage?.routerHealth ?? {}).map(([model, h]) => (
              <li key={model} className="tool-row">
                <div className="tool-row-head">
                  <span className="tool-name">{model}</span>
                  <span className="tag-lo">
                    {h.state === "cooling"
                      ? `COOLING · until ${new Date(h.cooldownUntil!).toLocaleTimeString()}`
                      : "HEALTHY"}
                  </span>
                </div>
                <p className="tool-desc">
                  {usage?.routerFailures[model] ?? 0} total failures
                  {h.consecutiveFailures > 0 && ` · ${h.consecutiveFailures} consecutive`}
                  {h.lastError && ` · last: ${h.lastError.slice(0, 90)}`}
                </p>
              </li>
            ))}
            {Object.keys(usage?.routerHealth ?? {}).length === 0 && (
              <li className="dim pad">
                No failures observed — every candidate is healthy. Cooling candidates are
                deprioritized (tried last), never removed.
              </li>
            )}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
