import { useEffect, useState } from "react";
import type { Mission, MissionStep, StepStatus } from "./api.js";
import { NODE_META } from "./FlowNode.js";

/**
 * Operation dossier (DESIGN-LANGUAGE §process is the hero): a mission renders
 * as a complete record — identity, live elapsed clock, per-step timeline bars
 * (timing observed from bus events, never invented), token telemetry, output,
 * error and diagnosis.
 */

export interface StepTiming {
  start?: number;
  end?: number;
}

const STATUS_LABEL: Record<StepStatus, string> = {
  pending: "PENDING",
  running: "RUNNING",
  succeeded: "OK",
  failed: "FAIL",
  skipped: "SKIP",
  awaiting_approval: "GATE",
};

const LIVE = new Set(["queued", "running", "awaiting_approval"]);

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** 1 Hz re-render while the mission is live, so T+ and bars advance. */
function useLiveTick(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

export function TraceDossier(props: {
  mission: Mission;
  steps: MissionStep[];
  timing: Record<string, StepTiming>;
  diagnosis: { summary: string; diagnosis: string } | null;
}) {
  const { mission, steps, timing } = props;
  const live = LIVE.has(mission.status);
  useLiveTick(live);
  const now = Date.now();

  // token telemetry (real usage recorded on step outputs)
  const tok = steps.reduce(
    (acc, s) => {
      const u = (s.output as { usage?: { inputTokens?: number; outputTokens?: number } } | null)?.usage;
      if (u) {
        acc.in += u.inputTokens ?? 0;
        acc.out += u.outputTokens ?? 0;
      }
      return acc;
    },
    { in: 0, out: 0 },
  );

  // timeline window: observed step timing, else mission start/finish
  const starts = Object.values(timing).map((t) => t.start).filter((n): n is number => n !== undefined);
  const t0 = starts.length
    ? Math.min(...starts)
    : mission.startedAt
      ? Date.parse(mission.startedAt)
      : undefined;
  const ends = Object.values(timing).map((t) => t.end ?? (live ? now : undefined)).filter((n): n is number => n !== undefined);
  const t1 = live ? now : ends.length ? Math.max(...ends) : mission.finishedAt ? Date.parse(mission.finishedAt) : undefined;
  const span = t0 !== undefined && t1 !== undefined ? Math.max(t1 - t0, 1) : undefined;

  const elapsed =
    mission.startedAt !== null
      ? (mission.finishedAt ? Date.parse(mission.finishedAt) : now) - Date.parse(mission.startedAt)
      : null;

  return (
    <>
      <dl className="dossier-meta">
        <dt>OP ID</dt>
        <dd className="mono">{mission.id.slice(0, 13)}</dd>
        <dt>KIND</dt>
        <dd>{mission.kind.toUpperCase()}</dd>
        <dt>{live ? "T+" : "DURATION"}</dt>
        <dd className={live ? "hot" : ""}>{elapsed !== null ? fmtMs(elapsed) : "—"}</dd>
        <dt>STEPS</dt>
        <dd>
          {steps.filter((s) => s.status === "succeeded").length}/{steps.length} COMPLETE
        </dd>
      </dl>

      {tok.in + tok.out > 0 && (
        <div className="trace-cost">
          <div className="trace-cost-row">
            <span>TOKENS IN</span>
            <b>{tok.in.toLocaleString()}</b>
          </div>
          <div className="trace-cost-row">
            <span>TOKENS OUT</span>
            <b>{tok.out.toLocaleString()}</b>
          </div>
        </div>
      )}

      <ul className="step-list">
        {steps.map((s) => {
          const t = timing[s.nodeId];
          const start = t?.start;
          const end = t?.end ?? (s.status === "running" ? now : undefined);
          const dur = start !== undefined && end !== undefined ? end - start : undefined;
          const hasBar = span !== undefined && t0 !== undefined && start !== undefined && end !== undefined;
          return (
            <li key={s.id} className={`step st-${s.status}`}>
              <span className="step-dot" />
              <span className="step-node">
                <span className="step-glyph">{NODE_META[s.kind]?.glyph}</span>
                {s.nodeId}
                {s.attempt > 1 && <span className="dim"> ·A{s.attempt}</span>}
              </span>
              <span className="step-ms">{dur !== undefined ? fmtMs(dur) : ""}</span>
              <span className="step-status">{STATUS_LABEL[s.status]}</span>
              {hasBar ? (
                <span className="step-lane" aria-hidden="true">
                  <span
                    className="step-bar"
                    style={{
                      left: `${(((start as number) - t0) / (span as number)) * 100}%`,
                      width: `${Math.max((((end as number) - (start as number)) / (span as number)) * 100, 1)}%`,
                    }}
                  />
                </span>
              ) : (
                <span className="step-sep" style={{ gridColumn: "1 / -1" }} />
              )}
            </li>
          );
        })}
      </ul>

      {mission.output !== null && mission.output !== undefined && (
        <div className="mission-output">
          <span className="tag-lo">OUTPUT</span>
          <pre>{JSON.stringify(mission.output, null, 2)}</pre>
        </div>
      )}
      {mission.error && (
        <div className="mission-output err">
          <span className="tag-lo">ERROR</span>
          <pre>{mission.error}</pre>
        </div>
      )}
      {props.diagnosis && (
        <div className="mission-output">
          <span className="tag-lo">DIAGNOSIS</span>
          <pre>
            {props.diagnosis.summary}
            {props.diagnosis.diagnosis ? `\n\n${props.diagnosis.diagnosis}` : ""}
          </pre>
        </div>
      )}
    </>
  );
}
