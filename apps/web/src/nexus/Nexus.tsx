import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, kbApi, prefsApi, type Mission } from "../api.js";
import { Construct, type ConstructData, type ConstructWorkflow } from "./Construct.js";
import { ROLE_RANK, TASKS, taskById, type NX } from "./registry.js";
import { TaskWindow, type PaneState } from "./TaskWindow.js";

/**
 * NEXUS (docs/NEXUS.md): the single-page operations theater. The Construct
 * fills the stage; every task opens as a translucent draggable pane above
 * it; the tray guarantees a path to every registry task; pane layout
 * persists per user in ui_preferences.layout.nexus.
 */

let paneSeq = 0;
const paneKey = () => `p${++paneSeq}-${Date.now().toString(36)}`;

interface PersistedPane {
  task: string;
  x: number;
  y: number;
  ctx?: Record<string, unknown>;
  z?: number;
}

export function Nexus(props: {
  nx: Omit<NX, "openPane">;
  /** External spawn order (palette): bump `n` to open `task`. */
  spawn: { task: string; ctx?: Record<string, unknown>; n: number } | null;
  reducedMotion: boolean;
}) {
  const [panes, setPanes] = useState<PaneState[]>([]);
  const zSeq = useRef(1);
  const restored = useRef(false);
  const autoHailed = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // --- Construct data (page-owned fetches; bus signals drive refresh) --------
  const [missions, setMissions] = useState<Mission[]>([]);
  const [docs, setDocs] = useState<{ id: string; chunkCount: number }[]>([]);
  const [toolServers, setToolServers] = useState<{ server: string; tools: number }[]>([]);
  const [wfNodes, setWfNodes] = useState<Record<string, number>>({});
  const missionEvents = useMemo(
    () => props.nx.signals.filter((s) => s.type.startsWith("mission")).length,
    [props.nx.signals],
  );

  useEffect(() => {
    api.listMissions().then(setMissions).catch(() => {});
  }, [missionEvents]);

  useEffect(() => {
    kbApi.list().then((d) => setDocs(d.map((x) => ({ id: x.id, chunkCount: x.chunkCount })))).catch(() => {});
    api.tools().then((t) => {
      const by = new Map<string, number>();
      for (const row of t as { server: string }[]) by.set(row.server, (by.get(row.server) ?? 0) + 1);
      setToolServers([...by.entries()].map(([server, tools]) => ({ server, tools })));
    }).catch(() => {});
  }, []);

  // True graph node counts for the lattice (bounded, once per workflow set).
  useEffect(() => {
    const missing = props.nx.workflows.filter((w) => wfNodes[w.id] === undefined).slice(0, 16);
    if (missing.length === 0) return;
    let dead = false;
    Promise.all(
      missing.map((w) =>
        api.getWorkflow(w.id).then(
          (r) => [w.id, r.version.graph.nodes.length] as const,
          () => [w.id, 0] as const,
        ),
      ),
    ).then((pairs) => {
      if (!dead) setWfNodes((m) => ({ ...m, ...Object.fromEntries(pairs) }));
    });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nx.workflows]);

  const constructWorkflows: ConstructWorkflow[] = useMemo(
    () =>
      props.nx.workflows.map((w) => ({
        id: w.id,
        name: w.name,
        currentVersion: w.currentVersion,
        nodeCount: wfNodes[w.id] ?? null,
      })),
    [props.nx.workflows, wfNodes],
  );

  const data: ConstructData = useMemo(
    () => ({
      agents: props.nx.agents,
      workflows: constructWorkflows,
      docs,
      toolServers,
      missions,
      approvals: props.nx.approvals,
      signals: props.nx.signals,
      connected: props.nx.connected,
      rxTotal: props.nx.rxTotal,
    }),
    [props.nx.agents, constructWorkflows, docs, toolServers, missions, props.nx.approvals, props.nx.signals, props.nx.connected, props.nx.rxTotal],
  );

  // --- pane operations ---------------------------------------------------------
  const openPane = useCallback((task: string, ctx: Record<string, unknown> = {}) => {
    const def = taskById(task);
    if (!def) return;
    if (def.jumpOnly) {
      if (def.jumpView) props.nx.navigate(def.jumpView);
      return;
    }
    setPanes((ps) => {
      // same task + same subject → raise, don't duplicate
      const subject = (ctx.agentId ?? ctx.workflowId ?? ctx.missionId ?? ctx.server ?? "") as string;
      const existing = ps.find((p) => {
        const ps2 = (p.ctx.agentId ?? p.ctx.workflowId ?? p.ctx.missionId ?? p.ctx.server ?? "") as string;
        return p.task === task && ps2 === subject;
      });
      if (existing) {
        return ps.map((p) => (p.key === existing.key ? { ...p, z: ++zSeq.current, ctx: { ...p.ctx, ...ctx } } : p));
      }
      const stage = stageRef.current;
      const n = ps.length;
      const baseX = stage ? Math.max(24, stage.clientWidth * 0.58) : 560;
      const x = (ctx.x as number) ?? baseX + ((n * 26) % 120);
      const y = (ctx.y as number) ?? 64 + ((n * 26) % 180);
      return [...ps, { key: paneKey(), task, x, y, z: ++zSeq.current, ctx }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nx.navigate]);

  const nx: NX = useMemo(() => ({ ...props.nx, openPane }), [props.nx, openPane]);

  const move = (key: string, x: number, y: number) =>
    setPanes((ps) => ps.map((p) => (p.key === key ? { ...p, x, y } : p)));
  const raise = (key: string) =>
    setPanes((ps) => {
      const top = Math.max(...ps.map((p) => p.z));
      const cur = ps.find((p) => p.key === key);
      if (!cur || cur.z === top) return ps;
      return ps.map((p) => (p.key === key ? { ...p, z: ++zSeq.current } : p));
    });
  const close = (key: string) => setPanes((ps) => ps.filter((p) => p.key !== key));
  const jump = (key: string) => {
    const pane = panes.find((p) => p.key === key);
    if (!pane) return;
    const def = taskById(pane.task);
    if (!def?.jumpView) return;
    // carry context to the full page
    if (pane.task === "agent.channel" && pane.ctx.agentId) props.nx.track("");
    if (pane.task === "mission.dossier" && pane.ctx.missionId) props.nx.track(pane.ctx.missionId as string);
    props.nx.navigate(def.jumpView);
    close(key);
  };

  // --- external spawn (⌘K palette) ----------------------------------------------
  const lastSpawn = useRef(0);
  useEffect(() => {
    if (props.spawn && props.spawn.n !== lastSpawn.current) {
      lastSpawn.current = props.spawn.n;
      openPane(props.spawn.task, props.spawn.ctx);
    }
  }, [props.spawn, openPane]);

  // --- auto-hail: authorization requests materialize a pane (§4.3) ---------------
  useEffect(() => {
    if (props.nx.approvals.length > 0 && !autoHailed.current) {
      autoHailed.current = true;
      setPanes((ps) => (ps.some((p) => p.task === "authorizations") ? ps : (openPane("authorizations"), ps)));
    }
    if (props.nx.approvals.length === 0) autoHailed.current = false;
  }, [props.nx.approvals, openPane]);

  // --- persistence (ui_preferences.layout.nexus) ---------------------------------
  useEffect(() => {
    prefsApi
      .get()
      .then(({ layout }) => {
        const saved = (layout as { nexus?: { panes?: PersistedPane[] } }).nexus;
        if (saved?.panes?.length) {
          setPanes(
            saved.panes
              .filter((p) => taskById(p.task) && !taskById(p.task)?.jumpOnly)
              .map((p) => ({ key: paneKey(), task: p.task, x: p.x, y: p.y, z: ++zSeq.current, ctx: p.ctx ?? {} })),
          );
        }
        restored.current = true;
      })
      .catch(() => {
        restored.current = true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      const persisted: PersistedPane[] = panes.map((p) => ({ task: p.task, x: p.x, y: p.y, ctx: p.ctx, z: p.z }));
      prefsApi.save({ nexus: { panes: persisted } }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [panes]);

  // --- tray ------------------------------------------------------------------------
  const rank = ROLE_RANK[props.nx.role];
  const trayTasks = TASKS.filter((t) => !t.hidden);
  const topZ = panes.reduce((m, p) => Math.max(m, p.z), 0);

  return (
    <div className="nx-wrap">
      <div className="nx-stage" ref={stageRef}>
        <Construct data={data} onOpen={openPane} reducedMotion={props.reducedMotion} />
        {panes.map((pane) => {
          const def = taskById(pane.task);
          if (!def?.body) return null;
          const Body = def.body;
          return (
            <TaskWindow
              key={pane.key}
              pane={pane}
              title={def.title}
              glyph={def.glyph}
              width={def.width ?? 380}
              focused={pane.z === topZ}
              canJump={def.jumpView !== null}
              onMove={move}
              onRaise={raise}
              onClose={close}
              onJump={jump}
            >
              <Body ctx={pane.ctx} nx={nx} />
            </TaskWindow>
          );
        })}
      </div>
      <div className="nx-tray" role="toolbar" aria-label="All system tasks">
        <span className="nx-tray-label">TASKS //</span>
        {trayTasks.map((t) => {
          const locked = rank < ROLE_RANK[t.minRole];
          const open = panes.some((p) => p.task === t.id);
          return (
            <button
              key={t.id}
              className={`nx-tray-chip ${open ? "open" : ""} ${locked ? "locked" : ""}`}
              title={locked ? `${t.title} — requires ${t.minRole}+` : t.jumpOnly ? `${t.title} — opens full page` : t.title}
              disabled={locked}
              onClick={() => openPane(t.id)}
            >
              <span className="nx-tray-glyph">{t.glyph}</span>
              {t.title}
              {t.jumpOnly && <span className="nx-tray-ext">⇱</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
