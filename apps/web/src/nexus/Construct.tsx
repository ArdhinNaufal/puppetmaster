import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, Approval, Mission } from "../api.js";
import type { SignalEntry } from "../Signal.js";

/**
 * The Construct (docs/NEXUS.md §2): Puppetmaster's avatar — an armillary
 * instrument whose every stratum is a real readout. Canvas 2D, one layout
 * pass per frame shared by the painter, the hit-tester and the keyboard
 * walker. All motion is state — idle is calm; reduced motion renders a
 * static, fully interactive diagram.
 */

export interface ConstructWorkflow {
  id: string;
  name: string;
  currentVersion: number;
  /** True node count from the stored graph; null until fetched. */
  nodeCount: number | null;
}

export interface ConstructData {
  agents: Agent[];
  workflows: ConstructWorkflow[];
  docs: { id: string; chunkCount: number }[];
  toolServers: { server: string; tools: number }[];
  missions: Mission[];
  approvals: Approval[];
  signals: SignalEntry[];
  connected: boolean;
  rxTotal: number;
}

interface CNode {
  kind: "kernel" | "agent" | "workflow" | "knowledge" | "spoke" | "thread" | "authrim";
  id: string;
  x: number;
  y: number;
  hit: number; // hit radius
  label: string;
  sub: string;
  active?: boolean;
  gated?: boolean;
}

/* ------------------------------------------------------------------ helpers */

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
  return h;
}
const bearing = (id: string, phase = 0) => ((hash(id) % 3600) / 3600) * Math.PI * 2 + phase;

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

const AUTONOMY_TICKS: Record<string, number> = { read_auto: 1, write_approved: 2, destructive_confirmed: 3 };
const LIVE_STATUS = new Set(["running", "awaiting_approval", "queued"]);

/* ---------------------------------------------------------------- component */

export function Construct(props: {
  data: ConstructData;
  onOpen: (task: string, ctx?: Record<string, unknown>) => void;
  reducedMotion: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef(props.data);
  dataRef.current = props.data;
  const onOpenRef = useRef(props.onOpen);
  onOpenRef.current = props.onOpen;

  const cursor = useRef({ x: 0, y: 0, inside: false });
  const tilt = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  const gaze = useRef(0);
  const nodesRef = useRef<CNode[]>([]);
  const focusRef = useRef<{ node: CNode; since: number; keyboard: boolean } | null>(null);
  const pulses = useRef<{ t0: number; tone: string; alarm: boolean }[]>([]);
  const lastSeq = useRef(0);
  const hold = useRef<{ t0: number } | null>(null);
  const pressed = useRef<{ node: CNode | null; t0: number; fired: boolean } | null>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1 });
  const renderRequested = useRef(false);
  const [announce, setAnnounce] = useState("");

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

  /* ---- layout pass: one node table shared by painter/hits/keyboard ------- */
  const layout = useCallback((): CNode[] => {
    const d = dataRef.current;
    const { w, h } = size.current;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.max(120, Math.min(w, h) / 2 - 36);
    const tx = tilt.current.x;
    const ty = tilt.current.y;
    const strata = (r: number) => 0.012 * (r / R) * 14; // px offset factor per stratum
    const place = (r: number, a: number): { x: number; y: number } => {
      let x = cx + r * Math.cos(a) - tx * strata(r) * 14;
      let y = cy + r * Math.sin(a) - ty * strata(r) * 14;
      // proximity ripple: strata bow away from the operator's hand
      if (cursor.current.inside) {
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

    const nodes: CNode[] = [];
    nodes.push({ kind: "kernel", id: "kernel", x: cx, y: cy, hit: R * 0.15, label: "KERNEL", sub: "CLICK · SIGNAL FEED — HOLD · SNAPSHOT" });

    const activeSubjects = new Set(
      d.signals.filter((s) => Date.now() - s.at < 20_000).map((s) => s.subject),
    );
    d.agents.forEach((a) => {
      const p = place(R * 0.42, bearing(a.id, 0.35));
      nodes.push({
        kind: "agent", id: a.id, x: p.x, y: p.y, hit: 16,
        label: a.name.toUpperCase(), sub: `${a.model.toUpperCase()} · OPEN CHANNEL`,
        active: activeSubjects.has(a.id),
      });
    });
    d.workflows.forEach((wf) => {
      const p = place(R * 0.6, bearing(wf.id, 1.15));
      nodes.push({
        kind: "workflow", id: wf.id, x: p.x, y: p.y, hit: 15,
        label: wf.name.toUpperCase(), sub: `v${wf.currentVersion}${wf.nodeCount ? ` · ${wf.nodeCount} NODES` : ""} · RUN`,
      });
    });
    {
      const p = place(R * 0.74, -Math.PI / 2);
      const chunks = d.docs.reduce((n, doc) => n + doc.chunkCount, 0);
      nodes.push({
        kind: "knowledge", id: "kb", x: p.x, y: p.y, hit: 18,
        label: "KNOWLEDGE SHELL", sub: `${d.docs.length} DOCS · ${chunks} CHUNKS · SEARCH`,
      });
    }
    d.toolServers.forEach((srv) => {
      const p = place(R * 0.86, bearing(srv.server, 2.1));
      nodes.push({
        kind: "spoke", id: srv.server, x: p.x, y: p.y, hit: 15,
        label: srv.server.toUpperCase(), sub: `${srv.tools} TOOLS · CATALOG`,
      });
    });
    d.missions.filter((m) => LIVE_STATUS.has(m.status)).slice(0, 12).forEach((m) => {
      const a = bearing(m.id, 4.2);
      const mid = place(R * 0.5, a);
      nodes.push({
        kind: "thread", id: m.id, x: mid.x, y: mid.y, hit: 14,
        label: `OP ${m.id.slice(0, 8)}`, sub: `${m.status.replace(/_/g, " ").toUpperCase()} · DOSSIER`,
        gated: m.status === "awaiting_approval",
      });
    });
    if (d.approvals.length > 0) {
      const p = place(R * 0.98, bearing(d.approvals[0]!.id, 0));
      nodes.push({
        kind: "authrim", id: "auth", x: p.x, y: p.y, hit: 16,
        label: "AUTHORIZATIONS", sub: `${d.approvals.length} PENDING · DECIDE`, gated: true,
      });
    }
    return nodes;
  }, []);

  /* ---- painter ------------------------------------------------------------ */
  const paint = useCallback((t: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const d = dataRef.current;
    const { w, h, dpr } = size.current;
    if (w === 0 || h === 0) return;
    const css = getComputedStyle(canvas);
    const C = {
      accent: css.getPropertyValue("--accent").trim() || "#45d6e6",
      stroke: css.getPropertyValue("--stroke").trim() || "#1c2c34",
      strokeHi: css.getPropertyValue("--stroke-hi").trim() || "#2c424d",
      warn: css.getPropertyValue("--warn").trim() || "#e2ac3f",
      danger: css.getPropertyValue("--danger").trim() || "#e25555",
      ok: css.getPropertyValue("--ok").trim() || "#4cd18e",
      hi: css.getPropertyValue("--text-hi").trim() || "#d9e6ea",
      lo: css.getPropertyValue("--text-lo").trim() || "#7d95a0",
    };
    const dormant = !d.connected;
    const running = d.missions.filter((m) => m.status === "running").length;
    const gated = d.approvals.length > 0;
    const motion = !props.reducedMotion && !dormant;
    const time = motion ? t / 1000 : 0;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.max(120, Math.min(w, h) / 2 - 36);
    const mono = '9px "IBM Plex Mono", monospace';
    if (dormant) ctx.globalAlpha = 0.45;

    // --- schema graticule ---------------------------------------------------
    ctx.strokeStyle = C.stroke;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.3, 0.4, Math.PI * 2 - 0.6);
    ctx.stroke();
    ctx.globalAlpha *= 0.7;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.52, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = dormant ? 0.45 : 1;
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

    // --- knowledge shell (particles; density is the readout) ----------------
    let particles = 0;
    for (const doc of d.docs) {
      if (particles >= 240) break;
      const rng = mulberry(hash(doc.id));
      const base = bearing(doc.id, -0.4);
      const count = Math.min(doc.chunkCount, 40, 240 - particles);
      for (let i = 0; i < count; i++) {
        const a = base + (rng() - 0.5) * 1.1;
        const r = R * (0.72 + rng() * 0.05);
        const x = cx + r * Math.cos(a) - tilt.current.x * 0.11;
        const y = cy + r * Math.sin(a) - tilt.current.y * 0.11;
        ctx.fillStyle = C.accent;
        ctx.globalAlpha = (dormant ? 0.45 : 1) * (0.16 + rng() * 0.3);
        ctx.fillRect(x, y, 1.4, 1.4);
        particles++;
      }
      // document major mote
      ctx.globalAlpha = dormant ? 0.45 : 0.75;
      ctx.beginPath();
      ctx.arc(cx + R * 0.74 * Math.cos(base), cy + R * 0.74 * Math.sin(base), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = dormant ? 0.45 : 1;

    // --- shared node table ----------------------------------------------------
    const nodes = layout();
    nodesRef.current = nodes;
    const focus = focusRef.current;

    // --- mission threads (the puppet strings) --------------------------------
    for (const n of nodes) {
      if (n.kind !== "thread") continue;
      const m = d.missions.find((mm) => mm.id === n.id);
      const a = bearing(n.id, 4.2);
      const x1 = cx + R * 0.16 * Math.cos(a);
      const y1 = cy + R * 0.16 * Math.sin(a);
      const x2 = cx + R * 0.93 * Math.cos(a);
      const y2 = cy + R * 0.93 * Math.sin(a);
      const gatedT = m?.status === "awaiting_approval";
      ctx.strokeStyle = gatedT ? C.warn : C.accent;
      ctx.globalAlpha = (dormant ? 0.45 : 1) * (focus?.node.id === n.id ? 1 : 0.75);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      if (gatedT) {
        // taut string, vibrating
        const vib = motion ? Math.sin(time * 30 + a) * 1.2 : 0;
        const px = -Math.sin(a) * vib;
        const py = Math.cos(a) * vib;
        ctx.moveTo(x1 + px, y1 + py);
        ctx.lineTo(x2 + px, y2 + py);
      } else {
        // slack string with flow
        const slack = R * 0.1;
        const mx = (x1 + x2) / 2 - Math.sin(a) * slack;
        const my = (y1 + y2) / 2 + Math.cos(a) * slack;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = motion ? -((time * 22) % 9) : 0;
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo(mx, my, x2, y2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // grip bead (the clickable handle for the dossier)
      ctx.fillStyle = gatedT ? C.warn : C.accent;
      ctx.save();
      ctx.translate(n.x, n.y);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-2.5, -2.5, 5, 5);
      ctx.restore();
    }
    ctx.globalAlpha = dormant ? 0.45 : 1;
    ctx.lineWidth = 1;

    // --- tool spokes -----------------------------------------------------------
    for (const n of nodes) {
      if (n.kind !== "spoke") continue;
      const srv = d.toolServers.find((s) => s.server === n.id);
      const a = bearing(n.id, 2.1);
      ctx.strokeStyle = C.strokeHi;
      ctx.beginPath();
      ctx.moveTo(cx + R * 0.82 * Math.cos(a), cy + R * 0.82 * Math.sin(a));
      ctx.lineTo(cx + R * 0.9 * Math.cos(a), cy + R * 0.9 * Math.sin(a));
      ctx.stroke();
      const ticks = Math.min(srv?.tools ?? 0, 12);
      for (let i = 0; i < ticks; i++) {
        const r = R * (0.82 + (0.08 * (i + 0.5)) / ticks);
        const px = cx + r * Math.cos(a);
        const py = cy + r * Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(px - Math.sin(a) * 3, py + Math.cos(a) * 3);
        ctx.lineTo(px + Math.sin(a) * 3, py - Math.cos(a) * 3);
        ctx.stroke();
      }
    }

    // --- workflow lattice -------------------------------------------------------
    for (const n of nodes) {
      if (n.kind !== "workflow") continue;
      const wf = d.workflows.find((x) => x.id === n.id);
      ctx.strokeStyle = focus?.node.id === n.id ? C.accent : C.strokeHi;
      ctx.save();
      ctx.translate(n.x, n.y);
      ctx.rotate(Math.PI / 4);
      ctx.strokeRect(-5, -5, 10, 10);
      ctx.restore();
      if (wf?.nodeCount && wf.nodeCount >= 3) {
        ctx.strokeStyle = C.accent;
        ctx.globalAlpha = (dormant ? 0.45 : 1) * 0.8;
        poly(ctx, n.x, n.y, 3.2, Math.min(wf.nodeCount, 12), motion ? time * 0.2 : 0);
        ctx.globalAlpha = dormant ? 0.45 : 1;
      }
    }

    // --- agent orbit ----------------------------------------------------------
    ctx.strokeStyle = C.stroke;
    ctx.globalAlpha *= 0.8;
    ctx.beginPath();
    ctx.arc(cx - tilt.current.x * 0.06, cy - tilt.current.y * 0.06, R * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = dormant ? 0.45 : 1;
    for (const n of nodes) {
      if (n.kind !== "agent") continue;
      const ag = d.agents.find((a) => a.id === n.id);
      const hot = n.active && motion;
      ctx.strokeStyle = n.active ? C.accent : focus?.node.id === n.id ? C.accent : C.strokeHi;
      if (hot) {
        ctx.shadowColor = C.accent;
        ctx.shadowBlur = 8;
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = n.active ? C.accent : C.lo;
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      // autonomy ticks
      const ticks = AUTONOMY_TICKS[ag?.autonomy ?? ""] ?? 1;
      ctx.strokeStyle = C.lo;
      for (let i = 0; i < ticks; i++) {
        const off = (i - (ticks - 1) / 2) * 4;
        ctx.beginPath();
        ctx.moveTo(n.x + off, n.y - 8);
        ctx.lineTo(n.x + off, n.y - 11);
        ctx.stroke();
      }
      // orbiting activity mote
      if (hot) {
        const oa = time * 2.4 + bearing(n.id);
        ctx.fillStyle = C.accent;
        ctx.beginPath();
        ctx.arc(n.x + 8 * Math.cos(oa), n.y + 8 * Math.sin(oa), 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- kernel core ------------------------------------------------------------
    const speed = 1 + Math.min(running, 3) * 0.7;
    const kcx = cx + tilt.current.x * 0.08;
    const kcy = cy + tilt.current.y * 0.08;
    ctx.strokeStyle = C.accent;
    if (!dormant) {
      poly(ctx, kcx, kcy, R * 0.13, 9, time * 0.05 * speed);
      ctx.strokeStyle = C.strokeHi;
      poly(ctx, kcx, kcy, R * 0.09, 6, -time * 0.09 * speed);
      ctx.strokeStyle = C.accent;
      poly(ctx, kcx, kcy, R * 0.05, 3, time * 0.16 * speed);
      // vertex dots on the outer nonagon
      for (let i = 0; i < 9; i++) {
        const a = time * 0.05 * speed + (i / 9) * Math.PI * 2;
        ctx.fillStyle = C.accent;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(kcx + R * 0.13 * Math.cos(a), kcy + R * 0.13 * Math.sin(a), 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // iris — the Construct watches the operator
      const g = gaze.current;
      ctx.strokeStyle = gated && motion && Math.sin(time * 2.1) > 0.55 ? C.warn : C.accent;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(kcx + R * 0.012 * Math.cos(g), kcy + R * 0.012 * Math.sin(g));
      ctx.lineTo(kcx + R * 0.042 * Math.cos(g), kcy + R * 0.042 * Math.sin(g));
      ctx.stroke();
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = C.lo;
      ctx.beginPath();
      ctx.arc(kcx, kcy, R * 0.09, 0, Math.PI * 2);
      ctx.stroke();
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
      ctx.arc(kcx, kcy, R * 0.16, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // --- event pulses (flash-settle ripples) -------------------------------------
    if (motion) {
      const now = performance.now();
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
      ctx.globalAlpha = dormant ? 0.45 : 1;
    }

    // --- rim: warning bezel --------------------------------------------------------
    const dayAgo = Date.now() - 86_400_000;
    const failed = d.missions.filter((m) => m.status === "failed" && Date.parse(m.createdAt) > dayAgo);
    for (const ap of d.approvals.slice(0, 24)) {
      const a = bearing(ap.id);
      ctx.strokeStyle = C.warn;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(cx + (R * 0.96) * Math.cos(a), cy + (R * 0.96) * Math.sin(a));
      ctx.lineTo(cx + (R * 1.0) * Math.cos(a), cy + (R * 1.0) * Math.sin(a));
      ctx.stroke();
    }
    for (const m of failed.slice(0, 24)) {
      const a = bearing(m.id, 0.8);
      ctx.strokeStyle = C.danger;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + (R * 0.97) * Math.cos(a), cy + (R * 0.97) * Math.sin(a));
      ctx.lineTo(cx + (R * 1.0) * Math.cos(a), cy + (R * 1.0) * Math.sin(a));
      ctx.stroke();
    }
    ctx.lineWidth = 1;

    // --- corner readouts (tertiary type stratum) -----------------------------------
    ctx.fillStyle = C.lo;
    ctx.font = mono;
    ctx.textAlign = "left";
    const chunks = d.docs.reduce((n, doc) => n + doc.chunkCount, 0);
    const toolCount = d.toolServers.reduce((n, s) => n + s.tools, 0);
    ctx.fillText(`AGENTS ${d.agents.length} · WORKFLOWS ${d.workflows.length}`, 10, 16);
    ctx.fillText(`TOOLS ${toolCount} · NS ${d.toolServers.length}`, 10, h - 10);
    ctx.textAlign = "right";
    ctx.fillText(`DOCS ${d.docs.length} / CHUNKS ${chunks}`, w - 10, 16);
    ctx.fillText(
      `RX ${d.rxTotal} · LIVE OPS ${d.missions.filter((m) => LIVE_STATUS.has(m.status)).length} · GATED ${d.approvals.length}`,
      w - 10,
      h - 10,
    );

    // --- magnet reticle + decode label ------------------------------------------------
    if (focus) {
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
      const dt = performance.now() - focus.since;
      const frac = props.reducedMotion ? 1 : Math.min(dt / 160, 1);
      const chars = Math.ceil(n.label.length * frac);
      ctx.font = '600 11px "Rajdhani", sans-serif';
      ctx.textAlign = "left";
      ctx.fillStyle = C.hi;
      const lx = n.x + rr + 8;
      const ly = n.y - 2;
      ctx.fillText(n.label.slice(0, chars), lx, ly);
      ctx.font = mono;
      ctx.fillStyle = C.lo;
      ctx.fillText(n.sub, lx, ly + 12);
    }
    ctx.globalAlpha = 1;
  }, [layout, props.reducedMotion]);

  const requestPaint = useCallback(() => {
    if (renderRequested.current) return;
    renderRequested.current = true;
    requestAnimationFrame((t) => {
      renderRequested.current = false;
      paint(t);
    });
  }, [paint]);

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
      const d = dataRef.current;
      const patient =
        !cursor.current.inside &&
        pulses.current.length === 0 &&
        !d.missions.some((m) => m.status === "running") &&
        !hold.current;
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
      // iris gaze with lag
      if (cursor.current.inside) {
        const want = Math.atan2(cursor.current.y - h / 2, cursor.current.x - w / 2);
        let delta = want - gaze.current;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        gaze.current += delta * 0.12;
      }
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
  }, [paint, requestPaint, props.reducedMotion]);

  // Repaint on data changes (only path to fresh pixels under reduced motion).
  useEffect(() => {
    requestPaint();
  }, [props.data, requestPaint]);

  /* ---- pointer + keyboard targeting ---------------------------------------- */
  const findNode = (x: number, y: number): CNode | null => {
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
  };

  const setFocus = (node: CNode | null, keyboard: boolean) => {
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
  };

  const activate = (n: CNode) => {
    switch (n.kind) {
      case "kernel":
        onOpenRef.current("signal.feed");
        break;
      case "agent":
        onOpenRef.current("agent.channel", { agentId: n.id });
        break;
      case "workflow":
        onOpenRef.current("workflow.run", { workflowId: n.id });
        break;
      case "knowledge":
        onOpenRef.current("knowledge.search");
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
    }
  };

  const d = props.data;
  const summary = `The Construct: ${d.agents.length} agents, ${d.workflows.length} workflows, ${d.docs.length} knowledge documents, ${d.toolServers.length} tool namespaces, ${d.missions.filter((m) => LIVE_STATUS.has(m.status)).length} live missions, ${d.approvals.length} pending authorizations. Bus ${d.connected ? "online" : "offline"}. Arrow keys walk the instrument; Enter opens the focused task.`;

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
        onKeyDown={(e) => {
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
          e.preventDefault();
          if (props.reducedMotion) requestPaint();
        }}
        onBlur={() => {
          if (focusRef.current?.keyboard) setFocus(null, true);
        }}
      />
      <span className="visually-hidden" aria-live="polite">{announce}</span>
    </div>
  );
}
