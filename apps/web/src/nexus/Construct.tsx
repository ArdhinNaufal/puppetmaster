import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, Approval, Mission } from "../api.js";
import type { SignalEntry } from "../Signal.js";

/**
 * The Construct v2.2 (docs/NEXUS.md §2): Puppetmaster's avatar — an armillary
 * instrument stacked in time. Strata group content by creation year; each
 * stratum is rings of radial bars (never dots) that counter-rotate
 * continuously — hovering an orbit (or a DISCOVERY locate) halts the motion,
 * dwells, auto-opens the destination pane, then the rotation resumes. The
 * kernel is a wandering pixel wave at rest (it leans toward the cursor) and
 * an aggressive signal-line burst while missions run. Running missions cast
 * dashed threads from the kernel circle to their bars; gated missions pulse
 * their bar scale instead. Wheel (or the +/− buttons) zooms the instrument —
 * zoomed in, the figure locks to the left half of the stage and the hovered
 * orbit spins its content past the cursor. Canvas 2D, one layout pass per
 * frame shared by painter, hit-tester and keyboard walker; reduced motion is
 * a static, fully interactive diagram (no rotation, no dwell auto-open —
 * click/Enter keep full parity).
 */

export interface ConstructWorkflow {
  id: string;
  name: string;
  currentVersion: number;
  /** True node count from the stored graph; null until fetched. */
  nodeCount: number | null;
  createdAt: string;
}

export interface ConstructDoc {
  id: string;
  title: string;
  chunkCount: number;
  createdAt: string;
}

export interface ConstructData {
  agents: Agent[];
  workflows: ConstructWorkflow[];
  docs: ConstructDoc[];
  toolServers: { server: string; tools: number }[];
  missions: Mission[];
  approvals: Approval[];
  signals: SignalEntry[];
  connected: boolean;
  rxTotal: number;
}

/** One stratum of the instrument: everything created in one year. */
export interface ConstructLayer {
  id: string;
  year: number;
  agents: Agent[];
  workflows: ConstructWorkflow[];
  docs: ConstructDoc[];
  toolServers: { server: string; tools: number }[];
  missions: Mission[];
  count: number;
}

export type LocateKind = "agent" | "workflow" | "doc" | "tool" | "mission";

/** Imperative surface the DISCOVERY pane drives (via Nexus). */
export interface ConstructApi {
  locate: (kind: LocateKind, id: string) => void;
}

/** Group the whole data snapshot into year strata (oldest → newest). */
export function buildLayers(d: ConstructData): ConstructLayer[] {
  const thisYear = new Date().getFullYear();
  const yearOf = (iso: string | null | undefined): number => {
    const y = iso ? new Date(iso).getFullYear() : NaN;
    return Number.isFinite(y) && y > 1990 && y <= thisYear + 1 ? y : thisYear;
  };
  const map = new Map<number, ConstructLayer>();
  const at = (y: number): ConstructLayer => {
    let l = map.get(y);
    if (!l) {
      l = { id: String(y), year: y, agents: [], workflows: [], docs: [], toolServers: [], missions: [], count: 0 };
      map.set(y, l);
    }
    return l;
  };
  d.agents.forEach((a) => at(yearOf(a.createdAt)).agents.push(a));
  d.workflows.forEach((w) => at(yearOf(w.createdAt)).workflows.push(w));
  d.docs.forEach((doc) => at(yearOf(doc.createdAt)).docs.push(doc));
  d.missions.forEach((m) => at(yearOf(m.createdAt)).missions.push(m));
  at(thisYear); // the present stratum always exists…
  const newest = Math.max(...map.keys());
  at(newest).toolServers = d.toolServers; // …tool namespaces have no birthday; they live on the newest stratum
  const layers = [...map.values()].sort((a, b) => a.year - b.year);
  for (const l of layers) {
    l.count = l.agents.length + l.workflows.length + l.docs.length + l.toolServers.length + l.missions.length;
  }
  return layers;
}

interface CNode {
  kind: "kernel" | "agent" | "workflow" | "knowledge" | "spoke" | "thread" | "authrim" | "layer";
  id: string;
  x: number;
  y: number;
  /** Bearing (rad) for ring nodes; 0 for kernel / depth-gauge chips. */
  a: number;
  hit: number; // hit radius
  label: string;
  sub: string;
  active?: boolean;
  gated?: boolean;
  failed?: boolean;
}

/* ------------------------------------------------------------------ helpers */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h;
}

/** Deterministic PRNG for knowledge particles (seeded by doc id). */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Radial bar centered on an orbit point — the content mark of every ring. */
function bar(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, len: number) {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  ctx.beginPath();
  ctx.moveTo(x - (dx * len) / 2, y - (dy * len) / 2);
  ctx.lineTo(x + (dx * len) / 2, y + (dy * len) / 2);
  ctx.stroke();
}

function poly(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, n: number, rot: number) {
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

/** Bar-height variation: every bar carries its data readout times a stable
 *  per-id unevenness (0.85–1.35) so the rings read like a live spectrum,
 *  not a picket fence. */
const jitter = (id: string) => 0.85 + ((hash(id) % 1000) / 1000) * 0.5;

const AUTONOMY_TICKS: Record<string, number> = { read_auto: 1, write_approved: 2, destructive_confirmed: 3 };
const LIVE_STATUS = new Set(["running", "awaiting_approval", "queued"]);
/** Display caps per stratum ring (search sees everything; the figure stays legible). */
const CAP = { agents: 24, workflows: 20, docs: 22, tools: 14, missions: 14 };
const NODE_KIND_FOR: Record<LocateKind, CNode["kind"]> = {
  agent: "agent",
  workflow: "workflow",
  doc: "knowledge",
  tool: "spoke",
  mission: "thread",
};

/** Orbit table: radius, spin direction and idle speed (rad/s) — every ring
 *  turns a different way at a different pace. */
const RINGS = {
  agent: { r: 0.42, dir: 1, speed: 0.05, offset: 0 },
  thread: { r: 0.52, dir: -1, speed: 0.04, offset: 0.5 },
  workflow: { r: 0.63, dir: 1, speed: 0.033, offset: 0 },
  knowledge: { r: 0.76, dir: -1, speed: 0.026, offset: 0.5 },
  spoke: { r: 0.88, dir: 1, speed: 0.02, offset: 0 },
} as const;
type RingKind = keyof typeof RINGS;
const RING_KINDS = Object.keys(RINGS) as RingKind[];
/** Spin rate of the hovered orbit while zoomed in (rad/s). */
const ZOOM_SPIN = 0.3;
/** Hover-dwell before the focused bar auto-opens its pane (ms). */
const DWELL_MS = 650;
const DWELL_COOLDOWN_MS = 1800;
const ZOOM_MIN = 1;
const ZOOM_MAX = 2.6;
/** Past this, the figure is "zoomed": it locks to the left half of the stage. */
const ZOOM_LOCK = 1.15;

interface Palette {
  accent: string;
  stroke: string;
  strokeHi: string;
  warn: string;
  danger: string;
  ok: string;
  hi: string;
  lo: string;
}

/* ---------------------------------------------------------------- component */

export function Construct(props: {
  data: ConstructData;
  layers: ConstructLayer[];
  active: string;
  onLayerChange: (id: string) => void;
  onOpen: (task: string, ctx?: Record<string, unknown>) => void;
  apiRef?: { current: ConstructApi | null };
  reducedMotion: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef(props.data);
  dataRef.current = props.data;
  const layersRef = useRef(props.layers);
  layersRef.current = props.layers;
  const activeRef = useRef(props.active);
  activeRef.current = props.active;
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;
  const onLayerRef = useRef(props.onLayerChange);
  onLayerRef.current = props.onLayerChange;
  const reducedRef = useRef(props.reducedMotion);
  reducedRef.current = props.reducedMotion;

  const cursor = useRef({ x: 0, y: 0, inside: false });
  const tilt = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const nodesRef = useRef<CNode[]>([]);
  const focusRef = useRef<{ node: CNode; since: number; keyboard: boolean } | null>(null);
  const pulses = useRef<{ t0: number; tone: string; alarm: boolean }[]>([]);
  const lastSeq = useRef(0);
  const hold = useRef<{ t0: number } | null>(null);
  const pressed = useRef<{ node: CNode | null; t0: number; fired: boolean } | null>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const renderRequested = useRef(false);
  /** Stratum shift in flight: dir 1 = diving deeper (older year), -1 = surfacing. */
  const trans = useRef<{ from: string; to: string; t0: number; dir: 1 | -1 } | null>(null);
  /** Homing beacon from DISCOVERY: waits out any stratum shift, converges, opens. */
  const locate = useRef<{ kind: CNode["kind"]; id: string; t0: number; until: number } | null>(null);
  const pixels = useRef<{ dx: number; dy: number; d: number }[]>([]);
  /** Continuous orbit rotation offsets, one per ring, advanced in the loop. */
  const rot = useRef<Record<RingKind, number>>({ agent: 0, thread: 0, workflow: 0, knowledge: 0, spoke: 0 });
  const lastFrame = useRef(0);
  /** Idle kernel wave direction (random walk; leans toward the cursor). */
  const waveDir = useRef(0);
  /** Hover-dwell auto-open bookkeeping. */
  const dwell = useRef<{ firedKey: string | null; cooldownUntil: number }>({ firedKey: null, cooldownUntil: 0 });
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const [announce, setAnnounce] = useState("");

  const setZoomClamped = useCallback((z: number) => {
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)));
  }, []);

  // Bus events → kernel pulses (flash-settle; alarms on failures).
  useEffect(() => {
    const fresh = props.data.signals.filter((s) => s.seq > lastSeq.current);
    if (fresh.length) {
      lastSeq.current = Math.max(...fresh.map((s) => s.seq));
      const now = performance.now();
      for (const s of fresh.slice(0, 3)) {
        pulses.current.push({ t0: now, tone: s.tone, alarm: s.tone === "danger" && s.type === "mission.finished" });
      }
      pulses.current = pulses.current.slice(-6);
    }
  }, [props.data.signals]);

  /* ---- view: one transform for figure geometry (zoom + left-half lock) ----- */
  const view = useCallback(() => {
    const { w, h } = size.current;
    const z = zoomRef.current;
    const baseR = Math.max(120, Math.min(w, h) / 2 - 36);
    // zoomed in → the figure locks into the left half of the stage
    const lockT = Math.max(0, Math.min(1, (z - 1) / (ZOOM_LOCK - 1 + 0.35)));
    const cx = w / 2 + (w * 0.28 - w / 2) * lockT;
    return { cx, cy: h / 2, R: baseR * z, baseR };
  }, []);

  /* ---- targeting ------------------------------------------------------------ */
  const findNode = useCallback((x: number, y: number): CNode | null => {
    let best: CNode | null = null;
    let bd = 48;
    for (const n of nodesRef.current) {
      const dist = Math.hypot(n.x - x, n.y - y) - (n.kind === "kernel" ? n.hit : 0);
      if (dist < bd) {
        bd = dist;
        best = n;
      }
    }
    return best;
  }, []);

  const setFocus = useCallback((node: CNode | null, keyboard: boolean) => {
    const cur = focusRef.current;
    if (node === null) {
      focusRef.current = null;
      if (cur) setAnnounce("");
    } else if (!cur || cur.node.id !== node.id || cur.node.kind !== node.kind) {
      focusRef.current = { node, since: performance.now(), keyboard };
      setAnnounce(`${node.label} — ${node.sub}`);
    }
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = node ? "pointer" : "default";
  }, []);

  const stepLayer = useCallback((dir: 1 | -1) => {
    const ls = layersRef.current;
    const i = ls.findIndex((l) => l.id === activeRef.current);
    const next = ls[i + dir];
    if (next) onLayerRef.current(next.id);
  }, []);

  const activate = useCallback((n: CNode) => {
    switch (n.kind) {
      case "kernel":
        onOpenRef.current("construct.discovery");
        break;
      case "agent":
        onOpenRef.current("agent.channel", { agentId: n.id });
        break;
      case "workflow":
        onOpenRef.current("workflow.run", { workflowId: n.id });
        break;
      case "knowledge":
        onOpenRef.current("knowledge.search", { docId: n.id });
        break;
      case "spoke":
        onOpenRef.current("tools.catalog", { server: n.id });
        break;
      case "thread":
        onOpenRef.current(n.gated ? "authorizations" : "mission.dossier", { missionId: n.id });
        break;
      case "authrim":
        onOpenRef.current("authorizations");
        break;
      case "layer":
        onLayerRef.current(n.id);
        break;
    }
  }, []);

  /* ---- layout pass: one node table shared by painter/hits/keyboard ------- */

  /** Ring nodes for one stratum: bars evenly spread, rotated by the orbit spin. */
  const layoutLayer = useCallback((layer: ConstructLayer, scale: number, interactive: boolean): CNode[] => {
    const v = view();
    const cx = v.cx;
    const cy = v.cy;
    const R = v.baseR * zoomRef.current * scale;
    const tx = interactive ? tilt.current.x : 0;
    const ty = interactive ? tilt.current.y : 0;
    const place = (r: number, a: number): { x: number; y: number } => {
      let x = cx + r * Math.cos(a) - tx * (r / R) * 2.35;
      let y = cy + r * Math.sin(a) - ty * (r / R) * 2.35;
      // proximity ripple: strata bow away from the operator's hand
      if (interactive && cursor.current.inside) {
        const dx = x - cursor.current.x;
        const dy = y - cursor.current.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 90 && dist > 0.01) {
          const push = (1 - dist / 90) * 6;
          x += (dx / dist) * push;
          y += (dy / dist) * push;
        }
      }
      return { x, y };
    };
    const spread = (kind: RingKind, i: number, n: number) =>
      -Math.PI / 2 + rot.current[kind] + ((i + RINGS[kind].offset) / Math.max(n, 1)) * Math.PI * 2;

    const d = dataRef.current;
    const activeSubjects = new Set(d.signals.filter((s) => Date.now() - s.at < 20_000).map((s) => s.subject));
    const nodes: CNode[] = [];

    const ags = layer.agents.slice(0, CAP.agents);
    ags.forEach((ag, i) => {
      const a = spread("agent", i, ags.length);
      const p = place(R * RINGS.agent.r, a);
      nodes.push({
        kind: "agent", id: ag.id, x: p.x, y: p.y, a, hit: 16,
        label: ag.name.toUpperCase(), sub: `${ag.model.toUpperCase()} · OPEN CHANNEL`,
        active: activeSubjects.has(ag.id),
      });
    });

    const live = layer.missions.filter((m) => LIVE_STATUS.has(m.status));
    const rest = layer.missions.filter((m) => !LIVE_STATUS.has(m.status));
    const ms = [...live, ...rest].slice(0, CAP.missions);
    ms.forEach((m, i) => {
      const a = spread("thread", i, ms.length);
      const p = place(R * RINGS.thread.r, a);
      nodes.push({
        kind: "thread", id: m.id, x: p.x, y: p.y, a, hit: 14,
        label: `OP ${m.id.slice(0, 8)}`,
        sub: `${m.status.replace(/_/g, " ").toUpperCase()} · DOSSIER`,
        active: LIVE_STATUS.has(m.status),
        gated: m.status === "awaiting_approval",
        failed: m.status === "failed",
      });
    });

    const wfs = layer.workflows.slice(0, CAP.workflows);
    wfs.forEach((wf, i) => {
      const a = spread("workflow", i, wfs.length);
      const p = place(R * RINGS.workflow.r, a);
      nodes.push({
        kind: "workflow", id: wf.id, x: p.x, y: p.y, a, hit: 15,
        label: wf.name.toUpperCase(),
        sub: `v${wf.currentVersion}${wf.nodeCount ? ` · ${wf.nodeCount} NODES` : ""} · RUN`,
      });
    });

    const docs = layer.docs.slice(0, CAP.docs);
    docs.forEach((doc, i) => {
      const a = spread("knowledge", i, docs.length);
      const p = place(R * RINGS.knowledge.r, a);
      nodes.push({
        kind: "knowledge", id: doc.id, x: p.x, y: p.y, a, hit: 13,
        label: doc.title.toUpperCase().slice(0, 26),
        sub: `${doc.chunkCount} CHUNKS · SEARCH`,
      });
    });

    const srvs = layer.toolServers.slice(0, CAP.tools);
    srvs.forEach((srv, i) => {
      const a = spread("spoke", i, srvs.length);
      const p = place(R * RINGS.spoke.r, a);
      nodes.push({
        kind: "spoke", id: srv.server, x: p.x, y: p.y, a, hit: 15,
        label: srv.server.toUpperCase(), sub: `${srv.tools} TOOLS · CATALOG`,
      });
    });

    return nodes;
  }, [view]);

  /** Kernel, authorization rim node and the depth gauge — stratum-independent. */
  const layoutChrome = useCallback((): { kernel: CNode; rest: CNode[] } => {
    const { w, h } = size.current;
    const v = view();
    const d = dataRef.current;
    const kernel: CNode = {
      kind: "kernel", id: "kernel", x: v.cx, y: v.cy, a: 0, hit: v.R * 0.15,
      label: "KERNEL", sub: "CLICK · DISCOVERY — HOLD · SNAPSHOT",
    };
    const rest: CNode[] = [];
    if (d.approvals.length > 0) {
      const a = -Math.PI / 3;
      rest.push({
        kind: "authrim", id: "auth", x: v.cx + v.R * 0.98 * Math.cos(a), y: v.cy + v.R * 0.98 * Math.sin(a), a, hit: 16,
        label: "AUTHORIZATIONS", sub: `${d.approvals.length} PENDING · DECIDE`, gated: true,
      });
    }
    const ls = layersRef.current;
    const chipW = 62;
    const x0 = w / 2 - ((ls.length - 1) * chipW) / 2;
    ls.forEach((l, i) => {
      rest.push({
        kind: "layer", id: l.id, x: x0 + i * chipW, y: h - 26, a: 0, hit: 15,
        label: l.id, sub: `STRATUM · ${l.count} UNITS · ENTER TO SHIFT`,
        active: l.id === activeRef.current,
      });
    });
    return { kernel, rest };
  }, [view]);

  /* ---- painter ------------------------------------------------------------ */

  /** Faint concentric echo of an adjacent stratum (above or below the active one). */
  const paintGhost = useCallback((ctx: CanvasRenderingContext2D, scale: number, alpha: number, C: Palette) => {
    const v = view();
    const R = v.baseR * zoomRef.current * scale;
    ctx.strokeStyle = C.stroke;
    ctx.globalAlpha = alpha;
    for (const r of [0.3, 0.52, 0.8]) {
      ctx.beginPath();
      ctx.arc(v.cx, v.cy, R * r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }, [view]);

  /** Paint one stratum at a zoom scale; returns its node table (for hits). */
  const paintLayer = useCallback((
    ctx: CanvasRenderingContext2D,
    layer: ConstructLayer,
    scale: number,
    A: number,
    interactive: boolean,
    time: number,
    C: Palette,
    motion: boolean,
  ): CNode[] => {
    const v = view();
    const cx = v.cx;
    const cy = v.cy;
    const R = v.baseR * zoomRef.current * scale;
    const nodes = layoutLayer(layer, scale, interactive);
    const focus = interactive ? focusRef.current : null;
    const al = (x: number) => {
      ctx.globalAlpha = Math.max(0, Math.min(1, x * A));
    };

    // --- schema graticule ---------------------------------------------------
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.stroke;
    al(1);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.3, 0.4, Math.PI * 2 - 0.6);
    ctx.stroke();
    al(0.7);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.52, 0, Math.PI * 2);
    ctx.stroke();
    al(1);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.8, 0, Math.PI * 2);
    ctx.stroke();
    for (let deg = 0; deg < 360; deg += 15) {
      const a = (deg * Math.PI) / 180;
      const len = deg % 45 === 0 ? 7 : 4;
      ctx.beginPath();
      ctx.moveTo(cx + (R * 0.8 - len) * Math.cos(a), cy + (R * 0.8 - len) * Math.sin(a));
      ctx.lineTo(cx + R * 0.8 * Math.cos(a), cy + R * 0.8 * Math.sin(a));
      ctx.stroke();
    }
    // orbit guides only where the stratum has content
    const guides: [number, boolean][] = [
      [RINGS.agent.r, layer.agents.length > 0],
      [RINGS.workflow.r, layer.workflows.length > 0],
      [RINGS.knowledge.r, layer.docs.length > 0],
      [RINGS.spoke.r, layer.toolServers.length > 0],
    ];
    for (const [r, on] of guides) {
      if (!on) continue;
      al(0.55);
      ctx.beginPath();
      ctx.arc(cx, cy, R * r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // --- knowledge shell: one bar per document, chunk particles around it -----
    let particles = 0;
    for (const n of nodes) {
      if (n.kind !== "knowledge" || particles >= 240) continue;
      const doc = layer.docs.find((x) => x.id === n.id);
      if (!doc) continue;
      const rng = mulberry(hash(doc.id));
      const count = Math.min(doc.chunkCount, 26, 240 - particles);
      for (let i = 0; i < count; i++) {
        const a = n.a + (rng() - 0.5) * 0.5;
        const r = R * (0.73 + rng() * 0.06);
        ctx.fillStyle = C.accent;
        al(0.16 + rng() * 0.3);
        ctx.fillRect(cx + r * Math.cos(a), cy + r * Math.sin(a), 1.4, 1.4);
        particles++;
      }
      // the document's bar: chunk weight × per-id unevenness
      ctx.strokeStyle = focus?.node.id === n.id ? C.accent : C.strokeHi;
      ctx.lineWidth = 1.6;
      al(0.9);
      bar(ctx, n.x, n.y, n.a, (5 + Math.min(doc.chunkCount, 24) * 0.55) * jitter(doc.id));
      ctx.lineWidth = 1;
    }

    // --- mission ring ----------------------------------------------------------
    // running → dashed thread flowing from the kernel circle to the bar;
    // gated  → the bar itself pulses scale (no thread);
    // settled → short bar whose height decays with age (recent = taller).
    for (const n of nodes) {
      if (n.kind !== "thread") continue;
      const m = layer.missions.find((x) => x.id === n.id);
      const running = m?.status === "running";
      const focused = focus?.node.id === n.id;
      if (running) {
        const x1 = cx + R * 0.16 * Math.cos(n.a);
        const y1 = cy + R * 0.16 * Math.sin(n.a);
        ctx.strokeStyle = C.accent;
        al(focused ? 1 : 0.8);
        ctx.lineWidth = 1.4;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = motion ? -((time * 26) % 9) : 0;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(n.x - Math.cos(n.a) * 9, n.y - Math.sin(n.a) * 9);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
      }
      let len: number;
      if (n.gated) {
        // constant change of scale — the bar breathes for a decision
        const pulse = motion ? 1 + 0.45 * Math.abs(Math.sin(time * 2.6 + hash(n.id) % 7)) : 1.25;
        len = 11 * pulse;
      } else if (running) {
        len = 16 * jitter(n.id);
      } else if (m?.status === "queued") {
        len = 10 * jitter(n.id);
      } else {
        const ageDays = m ? Math.max(0, (Date.now() - Date.parse(m.createdAt)) / 86_400_000) : 30;
        len = (6 + 6 * Math.exp(-ageDays / 21)) * jitter(n.id);
      }
      ctx.strokeStyle = n.gated ? C.warn : n.failed ? C.danger : n.active ? C.accent : C.lo;
      ctx.lineWidth = 2.4;
      al(n.active ? 1 : 0.6);
      bar(ctx, n.x, n.y, n.a, len);
      ctx.lineWidth = 1;
    }

    // --- tool namespaces: one bar per server, height = tool count ---------------
    for (const n of nodes) {
      if (n.kind !== "spoke") continue;
      const srv = layer.toolServers.find((s) => s.server === n.id);
      ctx.strokeStyle = focus?.node.id === n.id ? C.accent : C.strokeHi;
      ctx.lineWidth = 2;
      al(1);
      bar(ctx, n.x, n.y, n.a, (7 + Math.min(srv?.tools ?? 0, 14)) * jitter(n.id));
      ctx.lineWidth = 1;
    }

    // --- workflow lattice: one bar per workflow, height = graph size ------------
    for (const n of nodes) {
      if (n.kind !== "workflow") continue;
      const wf = layer.workflows.find((x) => x.id === n.id);
      ctx.strokeStyle = focus?.node.id === n.id ? C.accent : C.strokeHi;
      ctx.lineWidth = 2.4;
      al(1);
      bar(ctx, n.x, n.y, n.a, (7 + Math.min(wf?.nodeCount ?? 0, 12)) * jitter(n.id));
      ctx.lineWidth = 1;
    }

    // --- agent orbit: one bar per agent, height = autonomy tier ------------------
    for (const n of nodes) {
      if (n.kind !== "agent") continue;
      const ag = layer.agents.find((a) => a.id === n.id);
      const hot = n.active && motion;
      ctx.strokeStyle = n.active || focus?.node.id === n.id ? C.accent : C.strokeHi;
      ctx.lineWidth = 2.4;
      al(1);
      if (hot && interactive) {
        ctx.shadowColor = C.accent;
        ctx.shadowBlur = 8;
      }
      const ticks = AUTONOMY_TICKS[ag?.autonomy ?? ""] ?? 1;
      const breathe = hot ? 1 + 0.12 * Math.sin(time * 2.2 + (hash(n.id) % 7)) : 1;
      bar(ctx, n.x, n.y, n.a, (7 + ticks * 4) * jitter(n.id) * breathe);
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1;
      if (hot) {
        const oa = time * 2.4 + (hash(n.id) % 7);
        ctx.fillStyle = C.accent;
        ctx.beginPath();
        ctx.arc(n.x + 9 * Math.cos(oa), n.y + 9 * Math.sin(oa), 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    return nodes;
  }, [view, layoutLayer]);

  const paint = useCallback((t: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const d = dataRef.current;
    const { w, h, dpr } = size.current;
    if (w === 0 || h === 0) return;
    const css = getComputedStyle(canvas);
    const C: Palette = {
      accent: css.getPropertyValue("--accent").trim() || "#f4f4f0",
      stroke: css.getPropertyValue("--stroke").trim() || "#29292e",
      strokeHi: css.getPropertyValue("--stroke-hi").trim() || "#43434a",
      warn: css.getPropertyValue("--warn").trim() || "#e9b23c",
      danger: css.getPropertyValue("--danger").trim() || "#e8443a",
      ok: css.getPropertyValue("--ok").trim() || "#d9d9d2",
      hi: css.getPropertyValue("--text-hi").trim() || "#e9e9e4",
      lo: css.getPropertyValue("--text-lo").trim() || "#8f8f94",
    };
    const dormant = !d.connected;
    // A process is "running" if the snapshot says so — or if execution traffic
    // crossed the bus in the last 3s (fast missions finish between refetches).
    const busActive = d.signals.some(
      (s) => (s.type === "mission.step" || s.type === "mission.started") && Date.now() - s.at < 3000,
    );
    const running = d.missions.filter((m) => m.status === "running").length || (busActive ? 1 : 0);
    const gated = d.approvals.length > 0;
    const motion = !reducedRef.current && !dormant;
    const time = motion ? t / 1000 : 0;
    const now = performance.now();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    const v = view();
    const cx = v.cx;
    const cy = v.cy;
    const R = v.R;
    const zoomed = zoomRef.current > ZOOM_LOCK;
    const mono = '9px "IBM Plex Mono", monospace';
    const dim = dormant ? 0.45 : 1;

    const layers = layersRef.current;
    const activeLayer = layers.find((l) => l.id === activeRef.current) ?? layers[layers.length - 1];
    if (!activeLayer) return;

    // --- stratum shift (zoom ceremony) ---------------------------------------
    let tr = trans.current;
    let ringNodes: CNode[] = [];
    if (tr) {
      const p = Math.min((now - tr.t0) / 480, 1);
      if (p >= 1) {
        trans.current = null;
        tr = null;
      } else {
        const e = 1 - Math.pow(1 - p, 3);
        const zoomIn = tr.dir === 1; // deeper = older: camera dives through the active rings
        const fromScale = zoomIn ? 1 + e * 1.2 : 1 - e * 0.55;
        const toScale = zoomIn ? 0.45 + e * 0.55 : 2.2 - e * 1.2;
        const fromLayer = layers.find((l) => l.id === tr!.from);
        if (fromLayer) paintLayer(ctx, fromLayer, fromScale, (1 - e) * dim, false, time, C, motion);
        paintLayer(ctx, activeLayer, toScale, e * dim, false, time, C, motion);
      }
    }
    if (!tr) {
      // faint echo of adjacent strata — skipped when zoomed in (clutter)
      if (!zoomed) {
        const li = layers.indexOf(activeLayer);
        if (layers[li - 1]) paintGhost(ctx, 0.45, 0.12 * dim, C);
        if (layers[li + 1]) paintGhost(ctx, 1.9, 0.07 * dim, C);
      }
      ringNodes = paintLayer(ctx, activeLayer, 1, dim, true, time, C, motion);
    }

    // --- shared node table (kernel first, then rings, then chrome) -----------
    const chrome = layoutChrome();
    nodesRef.current = [chrome.kernel, ...ringNodes, ...chrome.rest];
    // the rings rotate — keep the focus snapshot glued to its bar
    if (focusRef.current) {
      const f = focusRef.current;
      const cur = nodesRef.current.find((n) => n.kind === f.node.kind && n.id === f.node.id);
      if (cur) f.node = cur;
    }
    const focus = focusRef.current;

    // --- kernel core ----------------------------------------------------------
    const kcx = cx + tilt.current.x * 0.08;
    const kcy = cy + tilt.current.y * 0.08;
    const kR = R * 0.15;
    const blink = motion && Math.sin(time * 2.1) > 0.55;
    if (running > 0 && motion) {
      // WORKING: aggressive random signal lines — the kernel is transmitting
      const rows = 5;
      const amp = Math.min(3 + running * 1.6, 8) * (kR / 45);
      for (let j = 0; j < rows; j++) {
        const dy = ((j + 0.5) / rows - 0.5) * 2 * kR * 0.78;
        const half = Math.sqrt(Math.max(kR * kR - dy * dy, 0)) * 0.92;
        ctx.strokeStyle = gated && blink && j === 0 ? C.warn : C.accent;
        ctx.globalAlpha = dim * (j === Math.floor(rows / 2) ? 0.95 : 0.55);
        ctx.lineWidth = j === Math.floor(rows / 2) ? 1.4 : 1;
        ctx.beginPath();
        const tick = Math.floor(time * 9);
        for (let x = -half; x <= half; x += 4) {
          const spike = (((hash(`${j}:${Math.floor(x / 4)}:${tick}`) % 1000) / 1000) - 0.5) * 2;
          const yy = dy + (Math.sin(x * 0.55 + time * 14 + j * 5) * 0.35 + spike * 0.65) * amp;
          if (x === -half) ctx.moveTo(kcx + x, kcy + yy);
          else ctx.lineTo(kcx + x, kcy + yy);
        }
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    } else {
      // IDLE: constant pixel wave with a wandering direction that leans
      // toward the operator's cursor
      let target = Math.sin(time * 0.23) * 2.1 + Math.sin(time * 0.11 + 1.7) * 1.4;
      if (cursor.current.inside && !dormant) {
        target = Math.atan2(cursor.current.y - kcy, cursor.current.x - kcx);
      }
      let delta = target - waveDir.current;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      waveDir.current += delta * (motion ? 0.05 : 1);
      const wa = waveDir.current;
      const ux = Math.cos(wa);
      const uy = Math.sin(wa);
      for (const px of pixels.current) {
        const proj = (px.dx * ux + px.dy * uy) / Math.max(kR, 1);
        const wave = 0.5 + 0.5 * Math.sin(proj * 6.5 - time * 2.4);
        const a = (0.08 + 0.72 * wave * wave) * (1 - px.d * 0.35);
        ctx.fillStyle = dormant ? C.lo : gated && blink && px.d > 0.72 ? C.warn : C.accent;
        ctx.globalAlpha = a * (dormant ? 0.35 : 1);
        ctx.fillRect(kcx + px.dx - 1.2, kcy + px.dy - 1.2, 2.4, 2.4);
      }
    }
    ctx.globalAlpha = dim;
    ctx.strokeStyle = dormant ? C.lo : gated && blink ? C.warn : C.strokeHi;
    ctx.beginPath();
    ctx.arc(kcx, kcy, kR, 0, Math.PI * 2);
    ctx.stroke();
    if (dormant) {
      ctx.fillStyle = C.lo;
      ctx.font = mono;
      ctx.textAlign = "center";
      ctx.fillText("LINK DOWN", kcx, kcy + R * 0.2);
    }

    // hold-to-snapshot progress ring
    if (hold.current) {
      const frac = Math.min((performance.now() - hold.current.t0) / 700, 1);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(kcx, kcy, R * 0.17, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // --- event pulses (flash-settle ripples) -------------------------------------
    if (motion) {
      pulses.current = pulses.current.filter((p) => now - p.t0 < (p.alarm ? 1200 : 700));
      for (const p of pulses.current) {
        const frac = (now - p.t0) / (p.alarm ? 1200 : 700);
        const tone = p.alarm ? C.danger : p.tone === "warn" ? C.warn : p.tone === "ok" ? C.ok : C.accent;
        ctx.strokeStyle = tone;
        ctx.globalAlpha = (1 - frac) * 0.5;
        ctx.beginPath();
        ctx.arc(cx, cy, R * (0.16 + frac * (p.alarm ? 0.84 : 0.55)), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = dim;
    }

    // --- rim: warning bezel (global — consequences transcend strata) -------------
    const dayAgo = Date.now() - 86_400_000;
    const failed = d.missions.filter((m) => m.status === "failed" && Date.parse(m.createdAt) > dayAgo);
    d.approvals.slice(0, 24).forEach((_, i) => {
      const a = -Math.PI / 2 + i * 0.07;
      ctx.strokeStyle = C.warn;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx + R * 0.96 * Math.cos(a), cy + R * 0.96 * Math.sin(a));
      ctx.lineTo(cx + R * 1.0 * Math.cos(a), cy + R * 1.0 * Math.sin(a));
      ctx.stroke();
    });
    failed.slice(0, 24).forEach((_, i) => {
      const a = Math.PI / 2 + i * 0.07;
      ctx.strokeStyle = C.danger;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + R * 0.97 * Math.cos(a), cy + R * 0.97 * Math.sin(a));
      ctx.lineTo(cx + R * 1.0 * Math.cos(a), cy + R * 1.0 * Math.sin(a));
      ctx.stroke();
    });
    ctx.lineWidth = 1;

    // --- authrim node: the widest warning bar, breathing for a decision ------------
    for (const n of chrome.rest) {
      if (n.kind !== "authrim") continue;
      const pulse = motion ? 1 + 0.45 * Math.abs(Math.sin(time * 2.6)) : 1.25;
      ctx.strokeStyle = C.warn;
      ctx.lineWidth = 3;
      bar(ctx, n.x, n.y, n.a, 13 * pulse);
      ctx.lineWidth = 1;
    }

    // --- depth gauge (stratum chips, bottom center) ---------------------------------
    {
      const chips = chrome.rest.filter((n) => n.kind === "layer");
      if (chips.length > 0) {
        ctx.font = mono;
        ctx.textAlign = "right";
        ctx.fillStyle = C.lo;
        ctx.globalAlpha = dim * 0.9;
        ctx.fillText("STRATA //", chips[0]!.x - 40, chips[0]!.y + 3);
        ctx.textAlign = "center";
        for (const n of chips) {
          const isActive = n.active === true;
          const isFocus = focus?.node.kind === "layer" && focus.node.id === n.id;
          ctx.fillStyle = isActive ? C.accent : isFocus ? C.hi : C.lo;
          ctx.globalAlpha = dim * (isActive ? 1 : 0.75);
          ctx.fillText(n.label, n.x, n.y + 3);
          const layer = layers.find((l) => l.id === n.id);
          const b = Math.min((layer?.count ?? 0) / 2, 22);
          ctx.fillRect(n.x - b / 2, n.y + 8, b, 1.5);
          if (isActive) {
            ctx.strokeStyle = C.accent;
            ctx.strokeRect(n.x - 24, n.y - 9, 48, 22);
          }
        }
        ctx.globalAlpha = dim;
      }
    }

    // --- DISCOVERY homing beacon ------------------------------------------------
    if (locate.current) {
      const lc = locate.current;
      if (trans.current) {
        lc.t0 = 0; // wait out the stratum shift
        lc.until = now + 4000;
      } else {
        const n = nodesRef.current.find((x) => x.kind === lc.kind && x.id === lc.id);
        if (!n) {
          if (now > lc.until) locate.current = null;
          else requestAnimationFrame(() => requestPaintRef.current());
        } else if (reducedRef.current) {
          setFocus(n, false);
          locate.current = null;
          activate(n); // pointed out → open the destination
        } else {
          if (lc.t0 === 0) lc.t0 = now;
          const p = Math.min((now - lc.t0) / 900, 1);
          const e = 1 - Math.pow(1 - p, 3);
          const tone = n.gated ? C.warn : n.failed ? C.danger : C.accent;
          ctx.strokeStyle = tone;
          // crosshair sweep from the stage edges
          const gap = n.hit + 12 + (1 - e) * 60;
          ctx.globalAlpha = 0.2 + 0.4 * e;
          for (const [x1, y1, x2, y2] of [
            [n.x, 0, n.x, n.y - gap],
            [n.x, h, n.x, n.y + gap],
            [0, n.y, n.x - gap, n.y],
            [w, n.y, n.x + gap, n.y],
          ] as const) {
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          }
          // kind-shaped converger: the reticle takes the target's own geometry
          const rr = n.hit + 6 + (1 - e) * 140;
          const rrot = (1 - e) * 2.4;
          ctx.globalAlpha = 0.35 + 0.6 * e;
          switch (n.kind) {
            case "agent":
              ctx.beginPath();
              ctx.arc(n.x, n.y, rr, rrot, rrot + Math.PI * 1.5);
              ctx.stroke();
              ctx.beginPath();
              ctx.arc(n.x, n.y, rr * 0.7, -rrot, -rrot + Math.PI * 1.5);
              ctx.stroke();
              break;
            case "workflow":
              poly(ctx, n.x, n.y, rr, 4, rrot + Math.PI / 4);
              break;
            case "knowledge":
              for (let i = 0; i < 12; i++) {
                const a = rrot + (i / 12) * Math.PI * 2;
                ctx.fillStyle = tone;
                ctx.fillRect(n.x + rr * Math.cos(a) - 1, n.y + rr * Math.sin(a) - 1, 2, 2);
              }
              break;
            case "spoke":
              ctx.setLineDash([4, 3]);
              ctx.beginPath();
              ctx.moveTo(cx + R * 0.2 * Math.cos(n.a), cy + R * 0.2 * Math.sin(n.a));
              ctx.lineTo(n.x, n.y);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
              ctx.stroke();
              break;
            default:
              // mission: flash the kernel thread line and converge a diamond
              ctx.beginPath();
              ctx.moveTo(cx + R * 0.16 * Math.cos(n.a), cy + R * 0.16 * Math.sin(n.a));
              ctx.lineTo(n.x, n.y);
              ctx.stroke();
              poly(ctx, n.x, n.y, rr * 0.8, 4, rrot);
          }
          ctx.globalAlpha = dim;
          if (p >= 1) {
            setFocus(n, false);
            locate.current = null;
            pulses.current.push({ t0: now, tone: n.gated ? "warn" : "accent", alarm: false });
            activate(n); // pointed out → auto-open the destination pane
          }
        }
      }
    }

    // --- corner readouts (tertiary type stratum) -----------------------------------
    ctx.fillStyle = C.lo;
    ctx.globalAlpha = dim;
    ctx.font = mono;
    ctx.textAlign = "left";
    const chunks = activeLayer.docs.reduce((n, doc) => n + doc.chunkCount, 0);
    const toolCount = activeLayer.toolServers.reduce((n, s) => n + s.tools, 0);
    ctx.fillText(
      `STRATUM ${activeLayer.id} — AGENTS ${activeLayer.agents.length} · WORKFLOWS ${activeLayer.workflows.length} · OPS ${activeLayer.missions.length}`,
      10,
      16,
    );
    ctx.fillText(`TOOLS ${toolCount} · NS ${activeLayer.toolServers.length}`, 10, h - 10);
    ctx.textAlign = "right";
    ctx.fillText(`DOCS ${activeLayer.docs.length} / CHUNKS ${chunks}`, w - 10, 16);
    ctx.fillText(
      `RX ${d.rxTotal} · LIVE OPS ${d.missions.filter((m) => LIVE_STATUS.has(m.status)).length} · GATED ${d.approvals.length} · ZOOM ${zoomRef.current.toFixed(1)}×`,
      w - 10,
      h - 10,
    );

    // --- magnet reticle + decode label + dwell progress ---------------------------
    if (focus && !tr) {
      const n = focus.node;
      const rr = n.hit + 5;
      ctx.strokeStyle = n.gated ? C.warn : C.accent;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        ctx.beginPath();
        ctx.moveTo(n.x + sx * rr, n.y + sy * rr - sy * 5);
        ctx.lineTo(n.x + sx * rr, n.y + sy * rr);
        ctx.lineTo(n.x + sx * rr - sx * 5, n.y + sy * rr);
        ctx.stroke();
      }
      // dwell ring: hover long enough and the destination opens itself
      if (motion && !focus.keyboard && n.kind !== "kernel" && n.kind !== "layer") {
        const key = `${n.kind}:${n.id}`;
        if (key !== dwell.current.firedKey) {
          const start = Math.max(focus.since, dwell.current.cooldownUntil);
          const frac = (now - start) / DWELL_MS;
          if (frac > 0) {
            ctx.strokeStyle = C.accent;
            ctx.globalAlpha = 0.85;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(n.x, n.y, rr + 5, -Math.PI / 2, -Math.PI / 2 + Math.min(frac, 1) * Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;
            ctx.globalAlpha = dim;
          }
        }
      }
      const dt2 = performance.now() - focus.since;
      const frac = reducedRef.current ? 1 : Math.min(dt2 / 160, 1);
      const chars = Math.ceil(n.label.length * frac);
      ctx.font = '600 11px "Rajdhani", sans-serif';
      ctx.textAlign = n.x > w - 180 ? "right" : "left";
      ctx.fillStyle = C.hi;
      const lx = n.x > w - 180 ? n.x - rr - 8 : n.x + rr + 8;
      const ly = n.y - 2;
      ctx.fillText(n.label.slice(0, chars), lx, ly);
      ctx.font = mono;
      ctx.fillStyle = C.lo;
      ctx.fillText(n.sub, lx, ly + 12);
    }
    ctx.globalAlpha = 1;
  }, [view, layoutLayer, layoutChrome, paintLayer, paintGhost, setFocus, activate]);

  const requestPaint = useCallback(() => {
    if (renderRequested.current) return;
    renderRequested.current = true;
    requestAnimationFrame((t) => {
      renderRequested.current = false;
      paint(t);
    });
  }, [paint]);
  const requestPaintRef = useRef(requestPaint);
  requestPaintRef.current = requestPaint;

  // Locate API for the DISCOVERY pane (via Nexus).
  useEffect(() => {
    const ref = props.apiRef;
    if (!ref) return;
    ref.current = {
      locate: (kind, id) => {
        locate.current = { kind: NODE_KIND_FOR[kind], id, t0: 0, until: performance.now() + 4000 };
        requestPaintRef.current();
      },
    };
    return () => {
      ref.current = null;
    };
  }, [props.apiRef]);

  // Stratum shift ceremony on active-layer change.
  const prevActive = useRef(props.active);
  useEffect(() => {
    if (prevActive.current === props.active) return;
    const from = prevActive.current;
    prevActive.current = props.active;
    const yearNum = (id: string) => Number(id) || 0;
    if (!props.reducedMotion && layersRef.current.some((l) => l.id === from)) {
      trans.current = { from, to: props.active, t0: performance.now(), dir: yearNum(props.active) < yearNum(from) ? 1 : -1 };
    }
    focusRef.current = null;
    setAnnounce(`Stratum ${props.active} active`);
    requestPaint();
  }, [props.active, props.reducedMotion, requestPaint]);

  /* ---- RAF loop (skipped under reduced motion) ----------------------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      size.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      // rebuild the kernel pixel lattice for the new radius
      const R = Math.max(120, Math.min(w, h) / 2 - 36);
      const kR = R * 0.135;
      const step = Math.max(4, Math.round(kR / 8));
      const px: { dx: number; dy: number; d: number }[] = [];
      for (let gy = -kR; gy <= kR; gy += step) {
        for (let gx = -kR; gx <= kR; gx += step) {
          const dist = Math.hypot(gx, gy);
          if (dist <= kR) px.push({ dx: gx, dy: gy, d: dist / kR });
        }
      }
      pixels.current = px;
      requestPaint();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    if (props.reducedMotion) {
      // static mode: repaint only on demand (data effect below, cursor, resize)
      return () => ro.disconnect();
    }

    let raf = 0;
    let frame = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      frame++;
      const now = performance.now();
      const dt = Math.min((t - (lastFrame.current || t)) / 1000, 0.1);
      lastFrame.current = t;
      const d = dataRef.current;

      // --- orbit rotation: each ring turns its own way, until the operator
      // (or DISCOVERY) points at something ------------------------------------
      const vw = view();
      const distC = Math.hypot(cursor.current.x - vw.cx, cursor.current.y - vw.cy);
      const hoverIn = cursor.current.inside && distC < vw.R * 1.02;
      let hoverRing: RingKind | null = null;
      if (hoverIn) {
        for (const k of RING_KINDS) {
          if (Math.abs(distC - vw.R * RINGS[k].r) < vw.R * 0.05) hoverRing = k;
        }
      }
      const f = focusRef.current;
      const focusKey = f ? `${f.node.kind}:${f.node.id}` : null;
      const zoomed = zoomRef.current > ZOOM_LOCK;
      const busy = !!locate.current || !!trans.current || (f?.keyboard ?? false);
      const dwellDone = focusKey !== null && focusKey === dwell.current.firedKey;
      for (const k of RING_KINDS) {
        let rate = 0;
        if (!busy) {
          if (!zoomed) {
            // pointing at an orbit (or a bar on it) halts the motion; once the
            // dwell has opened its pane, the spin resumes
            const pointed = (hoverRing !== null || (f !== null && !f.keyboard)) && !dwellDone;
            rate = pointed ? 0 : RINGS[k].speed * RINGS[k].dir;
          } else {
            // zoomed in: only the orbit under the cursor turns, parading its
            // content past the operator — a locked bar still halts it
            const dwelling = f !== null && !f.keyboard && !dwellDone;
            rate = k === hoverRing && !dwelling ? ZOOM_SPIN * RINGS[k].dir : 0;
          }
        }
        if (rate !== 0) rot.current[k] += rate * dt;
      }

      // --- hover dwell: the pointed-at bar opens its own pane -----------------
      if (f && !f.keyboard && f.node.kind !== "kernel" && f.node.kind !== "layer" && !busy) {
        const key = `${f.node.kind}:${f.node.id}`;
        if (key !== dwell.current.firedKey) {
          const start = Math.max(f.since, dwell.current.cooldownUntil);
          if (now - start > DWELL_MS) {
            dwell.current.firedKey = key;
            dwell.current.cooldownUntil = now + DWELL_COOLDOWN_MS;
            activate(f.node);
          }
        }
      }
      if (!hoverIn) dwell.current.firedKey = null;

      const patient =
        !cursor.current.inside &&
        pulses.current.length === 0 &&
        !d.missions.some((m) => m.status === "running") &&
        !hold.current &&
        !trans.current &&
        !locate.current;
      if (patient && frame % 2 === 1) return; // 30fps when idle — calm and cheap

      // tilt spring toward cursor offset (critically damped-ish)
      const { w, h } = size.current;
      const targX = cursor.current.inside ? Math.max(-1, Math.min(1, (cursor.current.x - w / 2) / (w / 2))) * 14 : 0;
      const targY = cursor.current.inside ? Math.max(-1, Math.min(1, (cursor.current.y - h / 2) / (h / 2))) * 14 : 0;
      const st = tilt.current;
      const k = 0.16;
      const dmp = 0.72;
      st.vx = (st.vx + (targX - st.x) * k) * dmp;
      st.vy = (st.vy + (targY - st.y) * k) * dmp;
      st.x += st.vx;
      st.y += st.vy;
      // hold ceremony completion (the release is then consumed, not a click)
      if (hold.current && performance.now() - hold.current.t0 >= 700) {
        hold.current = null;
        if (pressed.current) pressed.current.fired = true;
        onOpenRef.current("system.snapshot");
      }
      paint(t);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [paint, requestPaint, view, activate, props.reducedMotion]);

  // Repaint on data changes (only path to fresh pixels under reduced motion).
  useEffect(() => {
    requestPaint();
  }, [props.data, props.layers, zoom, requestPaint]);

  const d = props.data;
  const activeLayer = props.layers.find((l) => l.id === props.active);
  const summary =
    `The Construct: ${props.layers.length} strata by creation year; active stratum ${props.active} holds ` +
    `${activeLayer?.agents.length ?? 0} agents, ${activeLayer?.workflows.length ?? 0} workflows, ` +
    `${activeLayer?.docs.length ?? 0} knowledge documents, ${activeLayer?.toolServers.length ?? 0} tool namespaces and ` +
    `${activeLayer?.missions.length ?? 0} missions. ${d.approvals.length} pending authorizations. Bus ${d.connected ? "online" : "offline"}. ` +
    `Arrow keys walk the instrument; Enter opens the focused task; bracket keys or Page keys shift strata; ` +
    `plus and minus zoom; Enter on the kernel opens discovery.`;

  return (
    <div ref={wrapRef} className="nx-construct">
      <canvas
        ref={canvasRef}
        role="application"
        aria-label={summary}
        tabIndex={0}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          cursor.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, inside: true };
          setFocus(findNode(cursor.current.x, cursor.current.y), false);
          if (props.reducedMotion) requestPaint();
        }}
        onPointerLeave={() => {
          cursor.current.inside = false;
          hold.current = null;
          dwell.current.firedKey = null;
          setFocus(null, false);
          if (props.reducedMotion) requestPaint();
        }}
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const n = findNode(e.clientX - rect.left, e.clientY - rect.top);
          pressed.current = { node: n, t0: performance.now(), fired: false };
          if (n?.kind === "kernel") hold.current = { t0: performance.now() };
        }}
        onPointerUp={(e) => {
          const p = pressed.current;
          pressed.current = null;
          hold.current = null;
          // Only a press that began on this canvas — and whose hold ceremony
          // did not already fire — can count as a click.
          if (!p || p.fired) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const n = findNode(e.clientX - rect.left, e.clientY - rect.top);
          if (!n || !p.node || n.id !== p.node.id || n.kind !== p.node.kind) return;
          if (n.kind === "kernel") {
            const held = performance.now() - p.t0;
            if (held < 350) activate(n); // brief press = click; the 700ms hold fires in the loop
            else if (props.reducedMotion && held >= 700) onOpenRef.current("system.snapshot");
            return;
          }
          activate(n);
        }}
        onWheel={(e) => {
          // wheel = magnification: dive the lens, not the strata (those shift
          // via [ ] / PageUp / PageDown / the depth gauge / DISCOVERY)
          setZoomClamped(zoomRef.current * Math.exp(-e.deltaY * 0.0012));
        }}
        onKeyDown={(e) => {
          if (e.key === "[" || e.key === "PageDown") {
            stepLayer(-1);
          } else if (e.key === "]" || e.key === "PageUp") {
            stepLayer(1);
          } else if (e.key === "+" || e.key === "=") {
            setZoomClamped(zoomRef.current * 1.25);
          } else if (e.key === "-" || e.key === "_") {
            setZoomClamped(zoomRef.current / 1.25);
          } else {
            const nodes = nodesRef.current;
            if (nodes.length === 0) return;
            const cur = focusRef.current?.node ?? null;
            const idx = cur ? nodes.findIndex((n) => n.id === cur.id && n.kind === cur.kind) : -1;
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              setFocus(nodes[(idx + 1) % nodes.length]!, true);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              setFocus(nodes[(idx - 1 + nodes.length) % nodes.length]!, true);
            } else if ((e.key === "Enter" || e.key === " ") && cur) {
              activate(cur);
            } else if (e.key === "Escape") {
              setFocus(null, true);
            } else {
              return;
            }
          }
          e.preventDefault();
          if (props.reducedMotion) requestPaint();
        }}
        onBlur={() => {
          if (focusRef.current?.keyboard) setFocus(null, true);
        }}
      />
      <div className="nx-zoom" role="group" aria-label="Construct zoom">
        <button className="ph-btn" title="Zoom in (+)" onClick={() => setZoomClamped(zoom * 1.25)} disabled={zoom >= ZOOM_MAX}>
          ＋
        </button>
        <button className="ph-btn" title="Zoom out (−)" onClick={() => setZoomClamped(zoom / 1.25)} disabled={zoom <= ZOOM_MIN}>
          －
        </button>
        {zoom > ZOOM_LOCK && (
          <button className="ph-btn" title="Reset zoom" onClick={() => setZoomClamped(1)}>
            1:1
          </button>
        )}
      </div>
      <span className="visually-hidden" aria-live="polite">{announce}</span>
    </div>
  );
}
