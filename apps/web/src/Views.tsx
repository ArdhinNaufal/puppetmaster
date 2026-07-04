import { useEffect, useState } from "react";
import { Chip, Panel, Stat, StatusDot, StatusText, TierBadge } from "@puppetmaster/ui";
import {
  agentApi,
  api,
  memberApi,
  workspaceApi,
  type Agent,
  type AgentMemory,
  type MemberRow,
  type Mission,
  type Role,
  type Workspace,
} from "./api.js";

/* ---------------------------------------------------------------- Missions */

function fmtDuration(m: Mission): string {
  if (!m.startedAt) return "—";
  const end = m.finishedAt ? new Date(m.finishedAt).getTime() : Date.now();
  const ms = end - new Date(m.startedAt).getTime();
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
  };

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="MISSIONS" value={missions.length} /></Panel>
        <Panel><Stat label="RUNNING" value={counts.running} tone={counts.running ? "accent" : "default"} /></Panel>
        <Panel><Stat label="AWAITING APPROVAL" value={counts.gated} tone={counts.gated ? "warn" : "default"} /></Panel>
        <Panel><Stat label="FAILED" value={counts.failed} tone={counts.failed ? "danger" : "default"} /></Panel>
      </div>
      <Panel title="MISSION LOG" className="grow" scroll>
        <table className="fui-table">
          <thead>
            <tr><th></th><th>KIND</th><th>MISSION</th><th>STATUS</th><th>DURATION</th><th>NESTED</th></tr>
          </thead>
          <tbody>
            {missions.map((m) => (
              <tr
                key={m.id}
                className={props.selected === m.id ? "sel" : ""}
                onClick={() => props.onSelect(m.id)}
              >
                <td><StatusDot status={m.status} pulse={m.status === "running"} /></td>
                <td className="dim">{m.kind.toUpperCase()}</td>
                <td className="mono">{m.id.slice(0, 8)}</td>
                <td><StatusText status={m.status} /></td>
                <td className="dim">{fmtDuration(m)}</td>
                <td className="dim">{m.parentMissionId ? `↳ ${m.parentMissionId.slice(0, 8)}` : ""}</td>
              </tr>
            ))}
            {missions.length === 0 && (
              <tr><td colSpan={6} className="dim pad">No missions yet — run a workflow or chat with an agent.</td></tr>
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
  const [saving, setSaving] = useState(false);

  const refresh = () => agentApi.list().then(setAgents).catch(() => {});
  useEffect(() => {
    refresh();
  }, []);

  const agent = agents.find((a) => a.id === selected) ?? null;

  useEffect(() => {
    if (selected) agentApi.memories(selected).then(setMemories).catch(() => setMemories([]));
  }, [selected]);

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
      <Panel title="AGENT ROSTER" className="w-roster" scroll>
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
      <Panel title={agent ? `INSPECTOR · ${agent.name.toUpperCase()}` : "INSPECTOR"} className="grow" scroll
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
                {memories.length === 0 && <p className="dim">Nothing remembered yet.</p>}
                <ul className="mem-list">
                  {memories.map((m) => (
                    <li key={m.id}>▸ {m.content}</li>
                  ))}
                </ul>
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

export function ToolsView() {
  const [toolsList, setToolsList] = useState<ToolInfo[]>([]);
  useEffect(() => {
    api.tools().then((t) => setToolsList(t as ToolInfo[])).catch(() => {});
  }, []);

  const servers = [...new Set(toolsList.map((t) => t.server))];

  return (
    <div className="view-wrap">
      <div className="stat-row">
        <Panel><Stat label="MCP SERVERS / NAMESPACES" value={servers.length} tone="accent" /></Panel>
        <Panel><Stat label="TOOLS IN CATALOG" value={toolsList.length} /></Panel>
      </div>
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

/* ------------------------------------------------------------------- Admin */

const ASSIGNABLE_ROLES: Role[] = ["admin", "builder", "member"];

export function AdminView(props: { meId: string; onBrandingChange: (ws: Workspace) => void }) {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [memberErr, setMemberErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ email: "", name: "", password: "", role: "member" as Role });

  const refreshMembers = () => memberApi.list().then(setMembers).catch(() => {});
  useEffect(() => {
    workspaceApi.get().then(setWs).catch(() => {});
    refreshMembers();
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
      <Panel title="WORKSPACE BRANDING" actions={msg ? <span className="dim">{msg}</span> : undefined}>
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

      <Panel title={`MEMBERS · ${members.length}`} className="grow" scroll
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
    </div>
  );
}
