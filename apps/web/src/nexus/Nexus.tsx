import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, kbApi, prefsApi, type Mission } from "../api.js";
import {
  buildLayers,
  Construct,
  type ConstructApi,
  type ConstructData,
  type ConstructDoc,
  type ConstructWorkflow,
} from "./Construct.js";
import { ROLE_RANK, TASKS, taskById, type DiscoveryItem, type NX } from "./registry.js";
import { TaskWindow, type PaneState } from "./TaskWindow.js";

/**
 * NEXUS (docs/NEXUS.md): the single-page operations theater. The Construct
 * fills the stage; tasks open as translucent panes floating above it — they
 * drag anywhere and stack freely, but every pane *emerges* on a flank of the
 * stage (the emptier of left/right), never over the figure's center. Urgent
 * work (pending authorizations) and follow-ups (recent failed missions) hail
 * their panes one at a time on a cadence; tracking a mission from this page
 * opens its OPERATION LOG pane. The tray guarantees a path to every registry
 * task; pane layout persists per user in ui_preferences.layout.nexus.
 */

let paneSeq = 0;
const paneKey = () => `p${++paneSeq}-${Date.now().toString(36)}`;

interface PersistedPane {
  task: string;
  x?: number;
  y?: number;
  /** Interim dock-era layout; migrated back to a flank position on restore. */
  side?: "left" | "right";
  ctx?: Record<string, unknown>;
  z?: number;
}

/** Cadence between auto-hailed attention panes (§4.3). */
const HAIL_INTERVAL_MS = 2800;

export function Nexus(props: {
  nx: Omit<NX, "openPane" | "closeTask" | "construct">;
  /** External spawn order (palette): bump `n` to open `task`. */
  spawn: { task: string; ctx?: Record<string, unknown>; n: number } | null;
  reducedMotion: boolean;
}) {
  const [panes, setPanes] = useState<PaneState[]>([]);
  const zSeq = useRef(1);
  const restored = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);

  // --- Construct data (page-owned fetches; bus signals drive refresh) --------
  const [missions, setMissions] = useState<Mission[]>([]);
  const [docs, setDocs] = useState<ConstructDoc[]>([]);
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
    kbApi
      .list()
      .then((d) => setDocs(d.map((x) => ({ id: x.id, title: x.title, chunkCount: x.chunkCount, createdAt: x.createdAt }))))
      .catch(() => {});
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
        createdAt: w.createdAt,
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

  // --- strata: the Construct stacked by creation year -------------------------
  const layers = useMemo(() => buildLayers(data), [data]);
  const [layerChoice, setLayerChoice] = useState<string | null>(null);
  const activeLayer = layers.some((l) => l.id === layerChoice) ? layerChoice! : layers[layers.length - 1]!.id;
  const constructApi = useRef<ConstructApi | null>(null);

  const setLayer = useCallback((id: string) => setLayerChoice(id), []);
  const stepLayer = useCallback(
    (dir: 1 | -1) => {
      const i = layers.findIndex((l) => l.id === activeLayer);
      const next = layers[i + dir];
      if (next) setLayerChoice(next.id);
    },
    [layers, activeLayer],
  );

  // DISCOVERY's index: every unit on every stratum, plus every reachable task pane.
  const rank = ROLE_RANK[props.nx.role];
  const discoveryItems: DiscoveryItem[] = useMemo(() => {
    const items: DiscoveryItem[] = [];
    for (const l of layers) {
      l.agents.forEach((a) => items.push({ kind: "agent", id: a.id, label: a.name.toUpperCase(), sub: `AGENT · ${a.model.toUpperCase()}`, layerId: l.id }));
      l.workflows.forEach((w) => items.push({ kind: "workflow", id: w.id, label: w.name.toUpperCase(), sub: `WORKFLOW · v${w.currentVersion}`, layerId: l.id }));
      l.docs.forEach((doc) => items.push({ kind: "doc", id: doc.id, label: doc.title.toUpperCase(), sub: `KNOWLEDGE · ${doc.chunkCount} CHUNKS`, layerId: l.id }));
      l.toolServers.forEach((s) => items.push({ kind: "tool", id: s.server, label: s.server.toUpperCase(), sub: `TOOL NAMESPACE · ${s.tools} TOOLS`, layerId: l.id }));
      l.missions.forEach((m) => items.push({ kind: "mission", id: m.id, label: `OP ${m.id.slice(0, 8).toUpperCase()}`, sub: `MISSION · ${m.status.replace(/_/g, " ").toUpperCase()}`, layerId: l.id }));
    }
    for (const t of TASKS.filter((t) => !t.hidden && rank >= ROLE_RANK[t.minRole])) {
      items.push({ kind: "task", id: t.id, label: t.title, sub: `TASK PANE · ${t.category}` });
    }
    return items;
  }, [layers, rank]);

  // --- pane operations ---------------------------------------------------------
  /** Spawn coordinates on a flank of the stage: panes emerge left or right
   *  (the emptier side), never over the figure's center — then drag anywhere. */
  const flankSpawn = (ps: PaneState[], width: number): { x: number; y: number } => {
    const stage = stageRef.current;
    const W = stage?.clientWidth ?? 1200;
    const onLeft = ps.filter((p) => p.x + width / 2 < W / 2).length;
    const onRight = ps.length - onLeft;
    const side = onRight <= onLeft ? "right" : "left";
    const n = side === "right" ? onRight : onLeft;
    const x = side === "left" ? 16 + ((n * 26) % 96) : Math.max(16, W - width - 16 - ((n * 26) % 96));
    const y = 56 + ((n * 34) % 240);
    return { x, y };
  };

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
      const spawn = flankSpawn(ps, def.width ?? 380);
      const x = (ctx.x as number) ?? spawn.x;
      const y = (ctx.y as number) ?? spawn.y;
      return [...ps, { key: paneKey(), task, x, y, z: ++zSeq.current, ctx }];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nx.navigate]);

  const closeTask = useCallback((task: string) => {
    setPanes((ps) => ps.filter((p) => p.task !== task));
  }, []);

  /** Tracking a mission from this page surfaces its operation log (§4.3). */
  const nxTrack = props.nx.track;
  const trackAndLog = useCallback(
    (missionId: string) => {
      nxTrack(missionId);
      openPane("operation.log");
    },
    [nxTrack, openPane],
  );

  const nx: NX = useMemo(
    () => ({
      ...props.nx,
      openPane,
      closeTask,
      track: trackAndLog,
      construct: {
        layers: layers.map((l) => ({ id: l.id, year: l.year, count: l.count })),
        active: activeLayer,
        setLayer,
        step: stepLayer,
        locate: (kind, id) => constructApi.current?.locate(kind, id),
        items: discoveryItems,
      },
    }),
    [props.nx, openPane, closeTask, trackAndLog, layers, activeLayer, setLayer, stepLayer, discoveryItems],
  );

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

  // --- auto-hail cadence (§4.3): urgent + follow-up panes, one per interval ------
  // Urgent: pending authorizations. Follow-up: missions failed in the last 24h.
  // Each attention item hails once per session; closing it is a decision we
  // respect. The timer reads through a ref so shell re-renders (vitals
  // heartbeat and the like) never reset the cadence.
  const hailed = useRef(new Set<string>());
  const hailRef = useRef({ approvals: props.nx.approvals, missions, openPane });
  hailRef.current = { approvals: props.nx.approvals, missions, openPane };
  useEffect(() => {
    const t = setInterval(() => {
      const { approvals, missions, openPane } = hailRef.current;
      if (approvals.length === 0) hailed.current.delete("auth");
      const queue: { key: string; task: string; ctx: Record<string, unknown> }[] = [];
      if (approvals.length > 0) queue.push({ key: "auth", task: "authorizations", ctx: {} });
      const dayAgo = Date.now() - 86_400_000;
      for (const m of missions.filter((m) => m.status === "failed" && Date.parse(m.createdAt) > dayAgo).slice(0, 5)) {
        queue.push({ key: `fail:${m.id}`, task: "mission.dossier", ctx: { missionId: m.id } });
      }
      const next = queue.find((i) => !hailed.current.has(i.key));
      if (!next) return;
      hailed.current.add(next.key);
      openPane(next.task, next.ctx);
    }, HAIL_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  // --- persistence (ui_preferences.layout.nexus) ---------------------------------
  useEffect(() => {
    prefsApi
      .get()
      .then(({ layout }) => {
        const saved = (layout as { nexus?: { panes?: PersistedPane[] } }).nexus;
        if (saved?.panes?.length) {
          const W = stageRef.current?.clientWidth ?? 1200;
          setPanes(
            saved.panes
              .filter((p) => taskById(p.task) && !taskById(p.task)?.jumpOnly)
              .map((p) => {
                // dock-era layouts stored only a side — land them on that flank
                const width = taskById(p.task)?.width ?? 380;
                const x = p.x ?? (p.side === "right" ? Math.max(16, W - width - 24) : 24);
                const y = p.y ?? 64;
                return { key: paneKey(), task: p.task, x, y, z: ++zSeq.current, ctx: p.ctx ?? {} };
              }),
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
  const trayTasks = TASKS.filter((t) => !t.hidden);
  const topZ = panes.reduce((m, p) => Math.max(m, p.z), 0);

  return (
    <div className="nx-wrap">
      <div className="nx-stage" ref={stageRef}>
        <Construct
          data={data}
          layers={layers}
          active={activeLayer}
          onLayerChange={setLayer}
          onOpen={openPane}
          apiRef={constructApi}
          reducedMotion={props.reducedMotion}
        />
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
