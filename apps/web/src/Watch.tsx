import { useEffect, useState } from "react";
import { Sparkline } from "@puppetmaster/ui";
import type { AuditAppended, OpsVitals } from "./api.js";
import type { SignalEntry } from "./Signal.js";

/**
 * PROCESS WATCH (docs/PROCESS-WATCH.md): one shell-level instrument on every
 * page. Collapsed: live kernel resource readout. Expanded: vitals sparklines
 * (5-minute ring) + the merged real-time process log (model/tool calls from
 * audit summaries, mission/agent/authorization events from the bus) with the
 * active page presetting the filter to the process that page is about.
 */

export type WatchCat = "MODEL" | "TOOL" | "MISSION" | "AGENT" | "AUTH";
export type WatchFilter = "ALL" | WatchCat;

export interface ProcessRow {
  seq: number;
  at: number;
  cat: WatchCat;
  line: string;
  meta: string;
  tone: "default" | "accent" | "warn" | "danger" | "ok";
}

let rowSeq = 0;

export function rowFromAudit(e: AuditAppended): ProcessRow {
  const at = Date.parse(e.at) || Date.now();
  if (e.action === "llm.call") {
    const tok =
      e.inputTokens !== undefined || e.outputTokens !== undefined
        ? `${e.inputTokens ?? 0}→${e.outputTokens ?? 0} TOK`
        : "";
    return {
      seq: ++rowSeq,
      at,
      cat: "MODEL",
      line: `LLM · ${e.model ?? e.target ?? "?"}`,
      meta: [e.actorLabel ?? e.actorKind, tok].filter(Boolean).join(" · "),
      tone: "accent",
    };
  }
  return {
    seq: ++rowSeq,
    at,
    cat: "TOOL",
    line: `TOOL · ${e.target ?? "?"}`,
    meta: [e.actorLabel ?? e.actorKind, e.tier ? "GATED" : ""].filter(Boolean).join(" · "),
    tone: e.tier ? "warn" : "default",
  };
}

export function rowFromSignal(s: SignalEntry): ProcessRow {
  const cat: WatchCat = s.type.startsWith("mission")
    ? "MISSION"
    : s.type.startsWith("agent")
      ? "AGENT"
      : "AUTH";
  return { seq: ++rowSeq, at: s.at, cat, line: s.label, meta: s.subject.slice(0, 8), tone: s.tone };
}

/** Which process each page is about (docs/PROCESS-WATCH.md §1). */
const VIEW_PRESET: Record<string, WatchFilter> = {
  nexus: "ALL",
  command: "AGENT",
  canvas: "MISSION",
  templates: "MISSION",
  knowledge: "TOOL",
  missions: "MISSION",
  agents: "AGENT",
  tools: "TOOL",
  evals: "MODEL",
  admin: "ALL",
};

/** COMMAND is about the whole agent turn: agent msgs + the model/tool calls inside it. */
const COMMAND_CATS: WatchCat[] = ["AGENT", "MODEL", "TOOL"];

const FILTERS: WatchFilter[] = ["ALL", "MODEL", "TOOL", "MISSION", "AGENT", "AUTH"];

const fmtT = (ms: number) => new Date(ms).toISOString().slice(11, 19);

export function Watch(props: {
  view: string;
  vitals: OpsVitals[];
  rows: ProcessRow[];
  open: boolean;
  onToggle: () => void;
}) {
  const preset = VIEW_PRESET[props.view] ?? "ALL";
  const [filter, setFilter] = useState<WatchFilter>(preset);
  // Re-preset when the page changes; a chip click pins until the next page.
  useEffect(() => setFilter(preset), [preset]);

  const last = props.vitals[props.vitals.length - 1];
  const series = (pick: (v: OpsVitals) => number) => props.vitals.slice(-72).map(pick);

  const visible = props.rows.filter((r) => {
    if (filter === "ALL") return true;
    if (filter === "AGENT" && props.view === "command") return COMMAND_CATS.includes(r.cat);
    return r.cat === filter;
  });

  const lagTone = last && last.loopLagMs > 200 ? "danger" : last && last.loopLagMs > 50 ? "warn" : "default";
  const cpuTone = last && last.cpuPct > 80 ? "danger" : last && last.cpuPct > 50 ? "warn" : "default";

  return (
    <section className={`watch ${props.open ? "open" : ""}`} aria-label="Process watch">
      <button className="watch-rail" onClick={props.onToggle} title={props.open ? "Collapse process watch" : "Expand process watch"}>
        <span className="watch-label">WATCH //</span>
        {last ? (
          <span className="watch-readout">
            <span className={`wr tone-${cpuTone}`}>CPU <b>{last.cpuPct.toFixed(1)}%</b></span>
            <span className="wr">RSS <b>{last.rssMb}</b>MB</span>
            <span className="wr">HEAP <b>{last.heapMb}</b>MB</span>
            <span className={`wr tone-${lagTone}`}>LAG <b>{last.loopLagMs.toFixed(1)}</b>ms</span>
            <span className="wr">WS <b>{last.wsClients}</b></span>
            <span className="wr">OPS <b>{last.running}</b>▸{last.queued}⋯{last.gated}⚑</span>
            <span className="wr dim-part">UP {Math.floor(last.upSec / 3600)}h{String(Math.floor((last.upSec % 3600) / 60)).padStart(2, "0")}</span>
          </span>
        ) : (
          <span className="watch-readout"><span className="wr">AWAITING KERNEL VITALS…</span></span>
        )}
        <span className="watch-scope">FEED · {filter}{filter === preset ? " (PAGE)" : ""}</span>
        <span className="watch-chev">{props.open ? "▾" : "▴"}</span>
      </button>
      {props.open && (
        <div className="watch-drawer">
          <div className="watch-vitals">
            <VitalTile label="CPU %" value={last ? `${last.cpuPct.toFixed(1)}` : "—"} data={series((v) => v.cpuPct)} tone={cpuTone} />
            <VitalTile label="RSS MB" value={last ? String(last.rssMb) : "—"} data={series((v) => v.rssMb)} tone="default" />
            <VitalTile label="HEAP MB" value={last ? String(last.heapMb) : "—"} data={series((v) => v.heapMb)} tone="default" />
            <VitalTile label="LOOP LAG MS" value={last ? last.loopLagMs.toFixed(1) : "—"} data={series((v) => v.loopLagMs)} tone={lagTone} />
          </div>
          <div className="watch-log">
            <div className="watch-chips" role="group" aria-label="Process filter">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  className={`watch-chip ${filter === f ? "on" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setFilter(f);
                  }}
                >
                  {f}
                  {f === preset && <span className="watch-chip-page">◂ PAGE</span>}
                </button>
              ))}
            </div>
            <ul className="watch-rows">
              {visible.slice(0, 40).map((r) => (
                <li key={r.seq} className={`watch-row tone-${r.tone}`}>
                  <span className="wrow-t">{fmtT(r.at)}</span>
                  <span className={`wrow-cat cat-${r.cat.toLowerCase()}`}>{r.cat}</span>
                  <span className="wrow-line">{r.line}</span>
                  <span className="wrow-meta">{r.meta}</span>
                </li>
              ))}
              {visible.length === 0 && <li className="watch-row dim-part">No {filter === "ALL" ? "" : `${filter} `}activity yet — the log fills as the kernel works.</li>}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function VitalTile(props: { label: string; value: string; data: number[]; tone: "default" | "warn" | "danger" }) {
  return (
    <div className={`vital-tile tone-${props.tone}`}>
      <span className="vital-value">{props.value}</span>
      <span className="vital-label">{props.label}</span>
      {props.data.length > 1 && <Sparkline data={props.data} width={150} height={26} tone={props.tone === "default" ? "accent" : props.tone} />}
    </div>
  );
}
