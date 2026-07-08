import { useRef, useState, type ReactNode } from "react";

/**
 * NEXUS task pane (docs/NEXUS.md §4.1): a translucent container docked to the
 * left or right flank of the stage — panes never sit over the Construct's
 * center. The title rail is the drag handle: drag across the stage midline to
 * re-dock on the other flank, drag vertically to reorder within a flank.
 * Keyboard on the rail: ←/→ re-dock, ↑/↓ reorder, Escape closes; ⇱ jumps to
 * the task's full page.
 */

export type PaneSide = "left" | "right";

export interface PaneState {
  key: string;
  task: string;
  side: PaneSide;
  z: number;
  ctx: Record<string, unknown>;
}

export function TaskWindow(props: {
  pane: PaneState;
  title: string;
  glyph: string;
  focused: boolean;
  canJump: boolean;
  /** Move the pane to `side`, inserted at `index` among that flank's panes. */
  onDock: (key: string, side: PaneSide, index: number) => void;
  /** Reorder within the current flank by one slot. */
  onNudge: (key: string, dir: -1 | 1) => void;
  onRaise: (key: string) => void;
  onClose: (key: string) => void;
  onJump: (key: string) => void;
  children: ReactNode;
}) {
  const { pane } = props;
  const elRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number } | null>(null);
  const [lift, setLift] = useState<{ dx: number; dy: number } | null>(null);

  const startDrag = (e: React.PointerEvent) => {
    drag.current = { px: e.clientX, py: e.clientY };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setLift({ dx: e.clientX - drag.current.px, dy: e.clientY - drag.current.py });
  };
  const endDrag = (e: React.PointerEvent) => {
    const started = drag.current;
    drag.current = null;
    setLift(null);
    if (!started) return;
    const moved = Math.hypot(e.clientX - started.px, e.clientY - started.py);
    if (moved < 12) return; // a twitch is not a re-dock
    const stage = elRef.current?.closest(".nx-stage");
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const side: PaneSide = e.clientX - rect.left < rect.width / 2 ? "left" : "right";
    // insertion slot: count sibling panes on the target flank above the pointer
    let index = 0;
    for (const el of stage.querySelectorAll(`.nx-dock.${side} .nx-pane`)) {
      if (el === elRef.current) continue;
      const r = el.getBoundingClientRect();
      if (r.top + r.height / 2 < e.clientY) index++;
    }
    props.onDock(pane.key, side, index);
  };

  return (
    <div
      ref={elRef}
      className={`nx-pane ${props.focused ? "focused" : ""} ${lift ? "dragging" : ""}`}
      role="dialog"
      aria-label={props.title}
      style={lift ? { transform: `translate(${lift.dx}px, ${lift.dy}px)` } : undefined}
      onPointerDown={() => props.onRaise(pane.key)}
    >
      <span className="fui-bracket tl" />
      <span className="fui-bracket tr" />
      <span className="fui-bracket bl" />
      <span className="fui-bracket br" />
      <header
        className="nx-pane-rail"
        tabIndex={0}
        title="Drag across to re-dock · ↑↓ reorder · ←→ switch flank · Esc closes"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={() => {
          drag.current = null;
          setLift(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") props.onClose(pane.key);
          else if (e.key === "ArrowLeft") props.onDock(pane.key, "left", Number.MAX_SAFE_INTEGER);
          else if (e.key === "ArrowRight") props.onDock(pane.key, "right", Number.MAX_SAFE_INTEGER);
          else if (e.key === "ArrowUp") props.onNudge(pane.key, -1);
          else if (e.key === "ArrowDown") props.onNudge(pane.key, 1);
          else return;
          e.preventDefault();
        }}
      >
        <span className="nx-pane-grip" aria-hidden="true">⣿</span>
        <span className="nx-pane-title">
          <span className="nx-pane-glyph">{props.glyph}</span>
          {props.title}
        </span>
        <span className="nx-pane-btns">
          <button
            className="ph-btn"
            title={pane.side === "left" ? "Dock right" : "Dock left"}
            onClick={() => props.onDock(pane.key, pane.side === "left" ? "right" : "left", Number.MAX_SAFE_INTEGER)}
          >
            {pane.side === "left" ? "⇥" : "⇤"}
          </button>
          {props.canJump && (
            <button className="ph-btn" title="Open the full page for this task" onClick={() => props.onJump(pane.key)}>
              ⇱
            </button>
          )}
          <button className="ph-btn" title="Close" onClick={() => props.onClose(pane.key)}>
            ✕
          </button>
        </span>
      </header>
      <div className="nx-pane-body">{props.children}</div>
    </div>
  );
}
