import { useEffect, useState } from "react";
import type { BusEvent } from "./api.js";

/**
 * Signal instruments (DESIGN-LANGUAGE §process is the hero): nothing the
 * kernel does happens off-screen. Every bus event becomes a SignalEntry that
 * feeds the bottom ticker and the sidebar radar. All readouts are real data —
 * event type, subject id, wall-clock time.
 */

export interface SignalEntry {
  seq: number;
  at: number;
  type: BusEvent["type"];
  label: string;
  tone: "default" | "accent" | "warn" | "danger" | "ok";
  /** Stable subject (mission/agent id) — anchors the radar bearing. */
  subject: string;
}

let seq = 0;

/** Map a bus event to a ticker/radar entry. */
export function toSignal(e: BusEvent): SignalEntry {
  const at = Date.parse(e.at) || Date.now();
  const short = (id: string) => id.slice(0, 8);
  switch (e.type) {
    case "mission.started":
      return { seq: ++seq, at, type: e.type, subject: e.missionId, tone: "accent", label: `MISSION ${short(e.missionId)} LAUNCH` };
    case "mission.step":
      return {
        seq: ++seq,
        at,
        type: e.type,
        subject: e.missionId,
        tone: e.status === "failed" ? "danger" : e.status === "awaiting_approval" ? "warn" : "default",
        label: `${e.nodeId} ${e.status.replace(/_/g, " ").toUpperCase()}`,
      };
    case "mission.finished":
      return {
        seq: ++seq,
        at,
        type: e.type,
        subject: e.missionId,
        tone: e.status === "succeeded" ? "ok" : e.status === "failed" ? "danger" : "default",
        label: `MISSION ${short(e.missionId)} ${e.status.toUpperCase()}`,
      };
    case "approval.requested":
      return { seq: ++seq, at, type: e.type, subject: e.missionId, tone: "warn", label: `AUTHORIZATION REQUESTED · ${e.nodeId}` };
    case "approval.resolved":
      return {
        seq: ++seq,
        at,
        type: e.type,
        subject: e.missionId,
        tone: e.approved ? "ok" : "danger",
        label: `AUTHORIZATION ${e.approved ? "GRANTED" : "DENIED"}`,
      };
    case "agent.message":
      return { seq: ++seq, at, type: e.type, subject: e.agentId, tone: "accent", label: `AGENT ${short(e.agentId)} ${e.role.toUpperCase()} MSG` };
    case "agent.message.delta":
      return { seq: ++seq, at, type: e.type, subject: e.agentId, tone: "default", label: `AGENT ${short(e.agentId)} STREAMING` };
  }
}

const fmtTime = (ms: number) =>
  new Date(ms).toISOString().slice(11, 19);

/** Live UTC clock + session uptime; ticks once per second. */
function useNow(periodMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return now;
}

export function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Bottom signal rail: newest-first event feed, RX counter, UTC clock and
 * session uptime — the operator's instrument strip.
 */
export function SignalTicker(props: { entries: SignalEntry[]; total: number; connected: boolean; sessionStart: number }) {
  const now = useNow();
  const visible = props.entries.slice(0, 8);
  return (
    <footer className="signal-rail" aria-label="Live system signal feed">
      <span className="sig-label">SIG //</span>
      <div className="sig-feed">
        {visible.length === 0 && <span className="sig-idle">NO TRAFFIC — STANDING BY</span>}
        {visible.map((s, i) => (
          <span key={s.seq} className={`sig-entry tone-${s.tone} ${i === 0 ? "newest" : ""}`}>
            <span className="sig-t">{fmtTime(s.at)}</span>
            {s.label}
          </span>
        ))}
      </div>
      <span className="sig-meta">
        <span className="sig-up" title="Events received this session">RX {String(props.total).padStart(4, "0")}</span>
        <span className={`status ${props.connected ? "ok" : "down"}`}>{props.connected ? "BUS ●" : "BUS ○"}</span>
        <span className="sig-up" title="Session uptime">T+{fmtUptime(now - props.sessionStart)}</span>
        <span className="sig-clock">
          {fmtTime(now)}
          <span className="utc">UTC</span>
        </span>
      </span>
    </footer>
  );
}

/**
 * Radar field: each recent event is a ping. Bearing is a stable hash of the
 * subject id (a mission keeps its bearing across steps); range decays with
 * age until the ping falls off the scope after `windowMs`.
 */
export function SignalRadar(props: { entries: SignalEntry[]; connected: boolean; total: number; windowMs?: number }) {
  const windowMs = props.windowMs ?? 30_000;
  const now = useNow(1000);
  const size = 92;
  const c = size / 2;
  const rMax = c - 4;

  const bearing = (subject: string) => {
    let h = 0;
    for (let i = 0; i < subject.length; i++) h = (h * 31 + subject.charCodeAt(i)) >>> 0;
    return (h % 360) * (Math.PI / 180);
  };

  const pings = props.entries
    .filter((s) => now - s.at < windowMs)
    .slice(0, 24)
    .map((s) => {
      const age = (now - s.at) / windowMs; // 0 fresh → 1 stale
      const r = 6 + age * (rMax - 10);
      const a = bearing(s.subject);
      return { ...s, x: c + r * Math.cos(a), y: c + r * Math.sin(a), o: 1 - age * 0.75 };
    });

  const latest = props.entries[0];
  return (
    <div className="radar-wrap">
      <svg className="radar" viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`Signal radar: ${pings.length} events in the last ${Math.round(windowMs / 1000)} seconds`}>
        <g className="radar-rings">
          <circle cx={c} cy={c} r={rMax} />
          <circle cx={c} cy={c} r={rMax * 0.66} />
          <circle cx={c} cy={c} r={rMax * 0.33} />
        </g>
        <g className="radar-cross">
          <line x1={c} y1={4} x2={c} y2={size - 4} />
          <line x1={4} y1={c} x2={size - 4} y2={c} />
        </g>
        {props.connected && (
          <path
            className="radar-sweep"
            d={`M ${c} ${c} L ${c} ${c - rMax} A ${rMax} ${rMax} 0 0 1 ${c + rMax * 0.64} ${c - rMax * 0.77} Z`}
          />
        )}
        {pings.map((p) => (
          <circle key={p.seq} className={`radar-ping tone-${p.tone}`} cx={p.x} cy={p.y} r={1.8} opacity={p.o} />
        ))}
      </svg>
      <div className="radar-side">
        <span className="radar-count">{pings.length}</span>
        <span className="radar-line">CONTACTS / {Math.round(windowMs / 1000)}S</span>
        <span className="radar-line">
          {latest ? <>LAST · <b>{latest.label}</b></> : "FIELD CLEAR"}
        </span>
        <span className="radar-line">RX TOTAL · <b>{props.total}</b></span>
      </div>
    </div>
  );
}
