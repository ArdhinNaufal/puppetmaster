import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Puppetmaster FUI design system (docs/DESIGN-LANGUAGE.md v0.2): thin linework,
 * corner brackets, indexed small-caps title rails, restrained accent color, and
 * SVG instrument primitives (Gauge, Sparkline, MeterBar) that only ever render
 * real data. Import `@puppetmaster/ui/styles.css` once for tokens + styles.
 */

export type Tone = "default" | "accent" | "warn" | "danger" | "ok";

/* ------------------------------------------------------------------ Panel */

/** Command-center panel: 1px stroke, corner brackets, indexed title rail. */
export function Panel(props: {
  title?: string;
  /** Optional 2-digit index rendered before the title, e.g. "03". */
  index?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  scroll?: boolean;
  /** Draw the border with a trace-on animation on mount (reduced-motion safe). */
  trace?: boolean;
}) {
  return (
    <section className={`fui-panel ${props.trace ? "trace-on" : ""} ${props.className ?? ""}`}>
      <span className="fui-bracket tl" />
      <span className="fui-bracket tr" />
      <span className="fui-bracket bl" />
      <span className="fui-bracket br" />
      {props.title !== undefined && (
        <header className="fui-panel-rail">
          <span className="fui-panel-title">
            {props.index && <span className="fui-panel-index">{props.index}</span>}
            {props.title}
          </span>
          {props.actions && <span className="fui-panel-actions">{props.actions}</span>}
        </header>
      )}
      <div className={`fui-panel-body ${props.scroll ? "scroll" : ""}`}>{props.children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- Stat */

/** Telemetry stat: big numeral, small-caps label, optional tone + sparkline. */
export function Stat(props: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  /** Optional unit annotation rendered after the value (e.g. "TOK", "ms"). */
  unit?: string;
  /** Optional series rendered as a sparkline under the numeral. Real data only. */
  spark?: number[];
}) {
  return (
    <div className={`fui-stat tone-${props.tone ?? "default"}`}>
      <span className="fui-stat-value">
        {props.value}
        {props.unit && <span className="fui-stat-unit">{props.unit}</span>}
      </span>
      <span className="fui-stat-label">{props.label}</span>
      {props.spark && props.spark.length > 1 && <Sparkline data={props.spark} tone={props.tone} />}
    </div>
  );
}

/* -------------------------------------------------------------- Sparkline */

/** Thin polyline trace of a numeric series, with area fill at 8% opacity. */
export function Sparkline(props: { data: number[]; tone?: Tone; width?: number; height?: number }) {
  const w = props.width ?? 96;
  const h = props.height ?? 22;
  const pad = 2;
  const max = Math.max(...props.data, 1);
  const min = Math.min(...props.data, 0);
  const span = max - min || 1;
  const step = (w - pad * 2) / (props.data.length - 1);
  const pts = props.data.map((v, i) => {
    const x = pad + i * step;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      className={`fui-spark tone-${props.tone ?? "default"}`}
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
    >
      <polygon
        className="fui-spark-area"
        points={`${pad},${h - pad} ${pts.join(" ")} ${(pad + (props.data.length - 1) * step).toFixed(1)},${h - pad}`}
      />
      <polyline className="fui-spark-line" points={pts.join(" ")} />
      <circle
        className="fui-spark-tip"
        cx={pad + (props.data.length - 1) * step}
        cy={h - pad - ((props.data[props.data.length - 1]! - min) / span) * (h - pad * 2)}
        r="1.6"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ Gauge */

/** Radial instrument: 270° arc with tick ring; value/max, annotated numeral. */
export function Gauge(props: {
  value: number;
  max: number;
  label: string;
  tone?: Tone;
  /** Formatted numeral; defaults to the raw value. */
  display?: string;
  size?: number;
}) {
  const size = props.size ?? 92;
  const r = size / 2 - 8;
  const c = size / 2;
  const frac = props.max > 0 ? Math.min(Math.max(props.value / props.max, 0), 1) : 0;
  const start = 135; // degrees; 270° sweep leaves a 90° mouth at the bottom
  const sweep = 270 * frac;
  const arc = (from: number, deg: number) => {
    const a0 = ((from - 90) * Math.PI) / 180;
    const a1 = ((from + deg - 90) * Math.PI) / 180;
    const large = deg > 180 ? 1 : 0;
    return `M ${c + r * Math.cos(a0)} ${c + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${c + r * Math.cos(a1)} ${c + r * Math.sin(a1)}`;
  };
  const ticks = Array.from({ length: 28 }, (_, i) => {
    const a = ((start + (270 / 27) * i - 90) * Math.PI) / 180;
    const r0 = r + 4;
    const r1 = r + (i % 9 === 0 ? 8 : 6);
    return (
      <line
        key={i}
        x1={c + r0 * Math.cos(a)}
        y1={c + r0 * Math.sin(a)}
        x2={c + r1 * Math.cos(a)}
        y2={c + r1 * Math.sin(a)}
      />
    );
  });
  return (
    <div className={`fui-gauge tone-${props.tone ?? "default"}`}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={`${props.label}: ${props.display ?? props.value} of ${props.max}`}>
        <g className="fui-gauge-ticks">{ticks}</g>
        <path className="fui-gauge-track" d={arc(start, 270)} />
        {sweep > 0.5 && <path className="fui-gauge-arc" d={arc(start, sweep)} />}
        <text className="fui-gauge-value" x={c} y={c + 1} textAnchor="middle" dominantBaseline="middle">
          {props.display ?? props.value}
        </text>
        <text className="fui-gauge-pct" x={c} y={c + 14} textAnchor="middle">
          {Math.round(frac * 100)}%
        </text>
      </svg>
      <span className="fui-gauge-label">{props.label}</span>
    </div>
  );
}

/* --------------------------------------------------------------- MeterBar */

/** Segmented horizontal meter: n cells, filled proportionally to value/max. */
export function MeterBar(props: { value: number; max: number; segments?: number; tone?: Tone; label?: string }) {
  const n = props.segments ?? 24;
  const lit = props.max > 0 ? Math.round(Math.min(Math.max(props.value / props.max, 0), 1) * n) : 0;
  return (
    <div className={`fui-meter tone-${props.tone ?? "default"}`} role="meter" aria-valuenow={props.value} aria-valuemin={0} aria-valuemax={props.max} aria-label={props.label}>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={`fui-meter-cell ${i < lit ? "lit" : ""}`} />
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- Decode */

const GLYPHS = "▖▘▝▗░▒#$&<>/\\+=~ABCDEF0123456789";

/** Track reduced-motion changes so an active decode stops immediately. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

/**
 * Decode-in typography: text scramble-resolves over ~360ms whenever `text`
 * changes. Renders plain text under reduced motion or on the initial paint of
 * an unchanged value. Motion = state change only.
 */
export function Decode(props: { text: string; className?: string }) {
  const [shown, setShown] = useState(props.text);
  const prev = useRef(props.text);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const changed = props.text !== prev.current;
    prev.current = props.text;
    if (reducedMotion || !changed) {
      setShown(props.text);
      return;
    }
    const target = props.text;
    const steps = 9;
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      if (step >= steps) {
        clearInterval(timer);
        setShown(target);
        return;
      }
      const resolved = Math.floor((step / steps) * target.length);
      let out = target.slice(0, resolved);
      for (let i = resolved; i < target.length; i++) {
        out += target[i] === " " ? " " : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setShown(out);
    }, 40);
    return () => clearInterval(timer);
  }, [props.text, reducedMotion]);

  return (
    <span className={props.className}>
      <span aria-hidden="true">{shown}</span>
      <span className="fui-sr-only">{props.text}</span>
    </span>
  );
}

/* ----------------------------------------------------------------- Status */

/** Status dot with the shared mission/step palette. */
export function StatusDot(props: { status: string; pulse?: boolean }) {
  return <span className={`fui-dot st-${props.status} ${props.pulse ? "pulse" : ""}`} />;
}

/** Small-caps status text in the shared palette. */
export function StatusText(props: { status: string }) {
  return <span className={`fui-status st-${props.status}`}>{props.status.replace(/_/g, " ").toUpperCase()}</span>;
}

/* ------------------------------------------------------------------- Chip */

/** Compact action chip. */
export function Chip(props: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "accent" | "danger" | "solid";
  tiny?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`fui-chip tone-${props.tone ?? "default"} ${props.tiny ? "tiny" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  );
}

/* -------------------------------------------------------------- HoldToRun */

/**
 * Hold-to-authorize control (DESIGN-LANGUAGE §interaction ceremony): the
 * action fires only after the pointer (or Space/Enter) is held for `ms`
 * (default 700). Progress renders inside the control; releasing early
 * cancels. Consequence gets ceremony — declining stays a single click.
 */
export function HoldButton(props: {
  children: ReactNode;
  onComplete: () => void;
  ms?: number;
  tone?: "accent" | "danger";
  tiny?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const ms = props.ms ?? 700;
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const done = useRef(false);
  const disabledRef = useRef(Boolean(props.disabled));
  disabledRef.current = Boolean(props.disabled);
  const progressId = useId();
  const statusId = useId();

  const start = () => {
    if (disabledRef.current || timer.current) return;
    done.current = false;
    setHolding(true);
    setProgress(0);
    setAnnouncement("Confirmation hold started. Keep holding to complete.");
    const startedAt = Date.now();
    progressTimer.current = setInterval(() => {
      setProgress(Math.min(99, Math.round(((Date.now() - startedAt) / ms) * 100)));
    }, Math.max(50, Math.min(100, Math.round(ms / 10))));
    timer.current = setTimeout(() => {
      timer.current = null;
      if (progressTimer.current) {
        clearInterval(progressTimer.current);
        progressTimer.current = null;
      }
      if (disabledRef.current) {
        done.current = false;
        setProgress(0);
        setHolding(false);
        setAnnouncement("Confirmation hold cancelled because the control became unavailable.");
        return;
      }
      done.current = true;
      setProgress(100);
      setHolding(false);
      setAnnouncement("Confirmation complete.");
      props.onComplete();
    }, ms);
  };
  const cancel = () => {
    const wasHolding = timer.current !== null;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (progressTimer.current) {
      clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
    if (!done.current) {
      setHolding(false);
      setProgress(0);
      if (wasHolding) setAnnouncement("Confirmation hold cancelled.");
    }
  };
  useEffect(() => {
    if (props.disabled) cancel();
  }, [props.disabled]);
  useEffect(() => cancel, []);

  return (
    <>
      <button
        type="button"
        className={`fui-hold tone-${props.tone ?? "accent"} ${props.tiny ? "tiny" : ""} ${holding ? "holding" : ""}`}
        style={{ "--hold-ms": `${ms}ms` } as React.CSSProperties}
        disabled={props.disabled}
        title={props.title ?? "Hold to confirm"}
        aria-pressed={holding}
        aria-describedby={`${progressId} ${statusId}`}
        aria-keyshortcuts="Enter Space"
        onPointerDown={start}
        onPointerUp={cancel}
        onPointerLeave={cancel}
        onPointerCancel={cancel}
        onBlur={cancel}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            start();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === "Enter" || e.key === " ") cancel();
        }}
        onClick={(e) => e.preventDefault()}
      >
        <span className="fui-hold-fill" aria-hidden="true" />
        <span className="fui-hold-label">{props.children}</span>
      </button>
      <span
        id={progressId}
        className="fui-hold-progress"
        role="progressbar"
        aria-label="Confirmation hold progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        Confirmation progress {progress} percent.
      </span>
      <span id={statusId} className="fui-hold-progress" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

/* -------------------------------------------------------------- TierBadge */

/** Tier badge for the tool catalog / agent cards. */
export function TierBadge(props: { tier: string }) {
  const short = props.tier.startsWith("read")
    ? "READ"
    : props.tier.startsWith("write")
      ? "WRITE"
      : "DESTRUCTIVE";
  return <span className={`fui-tier t-${short.toLowerCase()}`}>{short}</span>;
}
