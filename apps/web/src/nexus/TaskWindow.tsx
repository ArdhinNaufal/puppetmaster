import { useEffect, useRef, type ReactNode } from "react";

/**
 * NEXUS task pane (docs/NEXUS.md §4.1): a translucent, draggable, stackable
 * container floating over the Construct. Panes move freely and overlap; only
 * their *spawn point* is disciplined (a flank of the stage — Nexus decides).
 * The title rail is the drag handle; pointerdown anywhere raises the pane;
 * ⇱ jumps to the task's full page. Keyboard: rail is focusable — arrows
 * nudge (Shift = 1px), Escape closes.
 */

export interface PaneState {
  key: string;
  task: string;
  x: number;
  y: number;
  z: number;
  ctx: Record<string, unknown>;
}

export function TaskWindow(props: {
  pane: PaneState;
  title: string;
  glyph: string;
  width: number;
  focused: boolean;
  canJump: boolean;
  onMove: (key: string, x: number, y: number) => void;
  onRaise: (key: string) => void;
  onClose: (key: string) => void;
  onJump: (key: string) => void;
  children: ReactNode;
}) {
  const { pane } = props;
  const elRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Keep the pane inside the stage if the stage shrinks.
  useEffect(() => {
    const el = elRef.current;
    const stage = el?.parentElement;
    if (!el || !stage) return;
    const clampX = Math.max(0, Math.min(pane.x, stage.clientWidth - 80));
    const clampY = Math.max(0, Math.min(pane.y, stage.clientHeight - 40));
    if (clampX !== pane.x || clampY !== pane.y) props.onMove(pane.key, clampX, clampY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.x, pane.y]);

  const startDrag = (e: React.PointerEvent) => {
    // the rail's buttons are buttons, not handles
    if ((e.target as HTMLElement).closest("button")) return;
    drag.current = { px: e.clientX, py: e.clientY, ox: pane.x, oy: pane.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const stage = elRef.current?.parentElement;
    const nx = drag.current.ox + (e.clientX - drag.current.px);
    const ny = drag.current.oy + (e.clientY - drag.current.py);
    const maxX = stage ? stage.clientWidth - 80 : nx;
    const maxY = stage ? stage.clientHeight - 40 : ny;
    props.onMove(pane.key, Math.max(0, Math.min(nx, maxX)), Math.max(0, Math.min(ny, maxY)));
  };
  const endDrag = () => {
    drag.current = null;
  };

  return (
    <div
      ref={elRef}
      className={`nx-pane ${props.focused ? "focused" : ""}`}
      role="dialog"
      aria-label={props.title}
      style={{ left: pane.x, top: pane.y, zIndex: 20 + pane.z, width: props.width }}
      onPointerDown={() => props.onRaise(pane.key)}
    >
      <span className="fui-bracket tl" />
      <span className="fui-bracket tr" />
      <span className="fui-bracket bl" />
      <span className="fui-bracket br" />
      <header
        className="nx-pane-rail"
        tabIndex={0}
        title="Drag to move · arrows nudge · Esc closes"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 1 : 16;
          if (e.key === "Escape") props.onClose(pane.key);
          else if (e.key === "ArrowLeft") props.onMove(pane.key, Math.max(0, pane.x - step), pane.y);
          else if (e.key === "ArrowRight") props.onMove(pane.key, pane.x + step, pane.y);
          else if (e.key === "ArrowUp") props.onMove(pane.key, pane.x, Math.max(0, pane.y - step));
          else if (e.key === "ArrowDown") props.onMove(pane.key, pane.x, pane.y + step);
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
