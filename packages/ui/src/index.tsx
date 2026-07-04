import type { ReactNode } from "react";

/**
 * Puppetmaster FUI design system (docs/DESIGN-LANGUAGE.md): thin linework,
 * corner brackets, small-caps title rails, restrained accent color. Import
 * `@puppetmaster/ui/styles.css` once for tokens + component styles.
 */

/** Command-center panel: 1px stroke, corner brackets, small-caps title rail. */
export function Panel(props: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <section className={`fui-panel ${props.className ?? ""}`}>
      <span className="fui-bracket tl" />
      <span className="fui-bracket tr" />
      <span className="fui-bracket bl" />
      <span className="fui-bracket br" />
      {props.title !== undefined && (
        <header className="fui-panel-rail">
          <span className="fui-panel-title">{props.title}</span>
          {props.actions && <span className="fui-panel-actions">{props.actions}</span>}
        </header>
      )}
      <div className={`fui-panel-body ${props.scroll ? "scroll" : ""}`}>{props.children}</div>
    </section>
  );
}

/** Telemetry stat: big numeral, small-caps label, optional tone. */
export function Stat(props: {
  label: string;
  value: ReactNode;
  tone?: "default" | "accent" | "warn" | "danger" | "ok";
}) {
  return (
    <div className={`fui-stat tone-${props.tone ?? "default"}`}>
      <span className="fui-stat-value">{props.value}</span>
      <span className="fui-stat-label">{props.label}</span>
    </div>
  );
}

/** Status dot with the shared mission/step palette. */
export function StatusDot(props: { status: string; pulse?: boolean }) {
  return <span className={`fui-dot st-${props.status} ${props.pulse ? "pulse" : ""}`} />;
}

/** Small-caps status text in the shared palette. */
export function StatusText(props: { status: string }) {
  return <span className={`fui-status st-${props.status}`}>{props.status.replace(/_/g, " ").toUpperCase()}</span>;
}

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
      className={`fui-chip tone-${props.tone ?? "default"} ${props.tiny ? "tiny" : ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  );
}

/** Tier badge for the tool catalog / agent cards. */
export function TierBadge(props: { tier: string }) {
  const short = props.tier.startsWith("read")
    ? "READ"
    : props.tier.startsWith("write")
      ? "WRITE"
      : "DESTRUCTIVE";
  return <span className={`fui-tier t-${short.toLowerCase()}`}>{short}</span>;
}
