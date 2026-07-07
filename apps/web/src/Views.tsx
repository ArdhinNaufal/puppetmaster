import { useEffect, useState } from "react";
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
  type Role,
  type RouterProfile,
  type Template,
  type UsageReport,
  type VerifyCheckRow,
  type Workflow,
  type Workspace,
} from "./api.js";

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

export function AgentsView(props: { onOpenChat: (agentId: string) => void; readOnly?: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [memQuery, setMemQuery] = useState("");
  const [memHits, setMemHits] = useState<MemoryHit[] | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = () => agentApi.list().then(setAgents).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const agent = agents.find((a) => a.id === selected) ?? null;

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
    await refresh();
    setSaving(false);
  };

  return (
    <div className="view-wrap cols">
      <Panel title="AGENT ROSTER" index="01" className="w-roster" scroll>
        <div className="agent-cards">
          {agents.map((a) => (
            <button key={a.id} className={`agent-card ${selected === a.id ? "sel" : ""}`} onClick={() => setSelected(a.id)}>
              <span className="agent-ring">◉</span>
              <span className="agent-card-name">{a.name}</span>
              <span className="agent-card-meta">{a.model}</span>
              <TierBadge tier={a.autonomy} />
            </button>
          ))}
          {agents.length === 0 && <p className="dim pad">No agents. Create one from the Command view.</p>}
        </div>
      </Panel>
      <Panel title={agent ? `INSPECTOR · ${agent.name.toUpperCase()}` : "INSPECTOR"} index="02" className="grow" scroll
        actions={agent ? <Chip tiny tone="accent" onClick={() => props.onOpenChat(agent.id)}>OPEN CHANNEL</Chip> : undefined}
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

export function ToolsView(props: { isAdmin?: boolean }) {
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
                    <button className="chip tiny" onClick={() => mcpApi.remove(r.id).then(refresh)}>REMOVE</button>
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
  onInstantiated: (kind: "workflow" | "agent", id: string) => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [wfs, setWfs] = useState<Workflow[]>([]);
  const [ags, setAgs] = useState<Agent[]>([]);
  const [pubRef, setPubRef] = useState("");
  const [pubName, setPubName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => templateApi.list().then(setTemplates).catch(() => {});
  useEffect(() => {
    refresh();
    if (props.canBuild) {
      api.listWorkflows().then(setWfs).catch(() => {});
      agentApi.list().then(setAgs).catch(() => {});
    }
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
                {wfs.length > 0 && (
                  <optgroup label="Workflows">
                    {wfs.map((w) => <option key={w.id} value={`workflow:${w.id}`}>{w.name}</option>)}
                  </optgroup>
                )}
                {ags.length > 0 && (
                  <optgroup label="Agents">
                    {ags.map((a) => <option key={a.id} value={`agent:${a.id}`}>{a.name}</option>)}
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

      <div className="tool-grid">
        {groups.map((g) => (
          <Panel key={g.kind} title={g.title} scroll>
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
                defaultValue={ws.branding.accent ?? "#35d0e0"}
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

/** KNOWLEDGE view (Stage 3): upload md/txt documents, browse them, and
 *  search-test the same hybrid retrieval the kb.search tool uses. */
export function KnowledgeView(props: { canBuild: boolean }) {
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [hits, setHits] = useState<KbSearchHit[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = () => kbApi.list().then(setDocs).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const upload = async () => {
    if (!title.trim() || !content.trim()) return;
    setBusy(true);
    try {
      const res = await kbApi.upload({ title: title.trim(), content });
      setNotice(`Ingested "${res.document.title}" — ${res.chunkCount} chunks, ${res.embedded} embedded.`);
      setTitle("");
      setContent("");
      refresh();
    } catch {
      setNotice("Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const onFile = (file: File) => {
    file.text().then((text) => {
      setContent(text);
      if (!title.trim()) setTitle(file.name.replace(/\.(md|txt|markdown)$/i, ""));
    });
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
                        onClick={() => kbApi.remove(d.id).then(refresh)}
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
                accept=".md,.txt,.markdown,text/plain,text/markdown"
                onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
              />
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

/** WORKSHOP view (AI-SDLC plan WP7a): projects + their artifact sets and
 *  verify checks. Phase-flow actions (interview, execute) arrive with WP5's
 *  remaining increments; this surface reads and manages what WP2/WP4 built. */
export function WorkshopView(props: { canBuild: boolean; isAdmin: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [artifacts, setArtifacts] = useState<ProjectArtifact[]>([]);
  const [checks, setChecks] = useState<VerifyCheckRow[]>([]);
  const [reading, setReading] = useState<ProjectArtifact | null>(null);
  const [name, setName] = useState("");
  const [repoRef, setRepoRef] = useState("");
  const [gated, setGated] = useState(false);
  const [notice, setNotice] = useState("");

  const refresh = () => projectApi.list().then(setProjects).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const open = (p: Project) => {
    setSelected(p);
    setReading(null);
    projectApi.artifacts(p.id).then(setArtifacts).catch(() => setArtifacts([]));
    projectApi.checks(p.id).then(setChecks).catch(() => setChecks([]));
  };

  const create = async () => {
    if (!name.trim()) return;
    try {
      const p = await projectApi.create({ name: name.trim(), repoRef: repoRef.trim(), mode: gated ? "gated" : "supervised" });
      setName("");
      setRepoRef("");
      setGated(false);
      refresh();
      open(p);
    } catch {
      setNotice("Create failed.");
    }
  };

  const toggleCheck = async (c: VerifyCheckRow) => {
    if (!props.isAdmin || !selected) return;
    const note = c.enabled
      ? c.earnedNote
      : window.prompt("Checks are earned policies. What failure earned this one?", c.earnedNote) ?? "";
    if (!c.enabled && !note.trim()) return; // enabling requires the earned note
    try {
      await projectApi.updateCheck(selected.id, c.id, { enabled: !c.enabled, earnedNote: note });
      projectApi.checks(selected.id).then(setChecks);
    } catch {
      setNotice("Check update failed.");
    }
  };

  const todos = artifacts.filter((a) => a.kind === "todo");
  const knowledge = artifacts.filter((a) => a.kind !== "todo");
  const PHASES = ["idle", "specify", "plan", "execute", "verify", "record"] as const;

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="PROJECTS" value={projects.length} tone="accent" /></Panel>
        <Panel><Stat label="ACTIVE TODOS" value={todos.filter((t) => t.status === "active").length} /></Panel>
        <Panel><Stat label="COMPLETED" value={todos.filter((t) => t.status === "completed").length} /></Panel>
        <Panel><Stat label="CHECKS ENABLED" value={checks.filter((c) => c.enabled).length} /></Panel>
      </div>

      <div className="tool-grid">
        <Panel title="PROJECTS" index="01" scroll>
          <ul className="tool-list">
            {projects.map((p) => (
              <li key={p.id} className="tool-row" onClick={() => open(p)} style={{ cursor: "pointer" }}>
                <div className="tool-row-head">
                  <span className="tool-name">{selected?.id === p.id ? "▸ " : ""}{p.name}</span>
                  <span className="tag-lo">{p.mode.toUpperCase()} · {p.phase.toUpperCase()}</span>
                </div>
                {p.repoRef && <p className="tool-desc">{p.repoRef}</p>}
              </li>
            ))}
            {projects.length === 0 && (
              <li className="dim pad">No projects yet — the Workshop is where software is built under verifiable gates.</li>
            )}
          </ul>
          {props.canBuild && (
            <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input className="text-input" placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
              <input className="text-input" placeholder="Repo ref (optional until the workbench lands)" value={repoRef} onChange={(e) => setRepoRef(e.target.value)} />
              <label className="tag-lo" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={gated} onChange={(e) => setGated(e.target.checked)} />
                GATED MODE (autonomous between verify gates — requires enabled checks to run)
              </label>
              <button className="chip" disabled={!name.trim()} onClick={create}>CREATE PROJECT</button>
              {notice && <p className="dim">{notice}</p>}
            </div>
          )}
        </Panel>

        <Panel title={selected ? `DOSSIER · ${selected.name.toUpperCase()}` : "DOSSIER"} index="02" scroll>
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
                {knowledge.map((a) => (
                  <li key={a.id} className="tool-row" onClick={() => setReading(a)} style={{ cursor: "pointer" }}>
                    <div className="tool-row-head">
                      <span className="tool-name">{a.title}</span>
                      <span className="tag-lo">
                        {a.kind.toUpperCase()} v{a.version}
                        {a.status ? ` · ${a.status.toUpperCase()}` : ""}
                      </span>
                    </div>
                  </li>
                ))}
                {knowledge.length === 0 && <li className="dim pad">No spec/plan/learnings/ADR artifacts yet.</li>}
              </ul>
              {reading && (
                <pre className="appr-evidence" style={{ maxHeight: 260, overflowY: "auto" }}>
                  {`${reading.kind.toUpperCase()} · ${reading.title} (v${reading.version})\n\n${reading.body || "(empty)"}`}
                </pre>
              )}
            </div>
          )}
        </Panel>

        <Panel title="VERIFY CHECKS" index="03" scroll>
          {!selected && <p className="dim pad">Checks are earned policies, per project — off by default.</p>}
          {selected && (
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
                  {c.earnedNote && <p className="tool-desc">earned: {c.earnedNote}</p>}
                  {props.isAdmin && (
                    <p className="tool-desc">
                      <button className="chip tiny" onClick={() => toggleCheck(c)}>
                        {c.enabled ? "DISABLE" : "ENABLE (EARN)"}
                      </button>
                    </p>
                  )}
                </li>
              ))}
              {checks.length === 0 && <li className="dim pad">No checks configured. Gated mode refuses to run without one.</li>}
            </ul>
          )}
        </Panel>
      </div>
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
