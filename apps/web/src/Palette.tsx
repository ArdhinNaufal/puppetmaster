import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Command palette (⌘K) — the fast path through the command center
 * (DESIGN-LANGUAGE §layout). Pure navigation/selection: filter, arrows,
 * enter. Fully keyboard-driven; Escape closes.
 */

export interface PaletteAction {
  id: string;
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

function matches(query: string, action: PaletteAction): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${action.group} ${action.label} ${action.keywords ?? ""}`.toLowerCase();
  // every whitespace-separated term must appear somewhere
  return q.split(/\s+/).every((term) => hay.includes(term));
}

export function Palette(props: { open: boolean; actions: PaletteAction[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const hits = useMemo(() => props.actions.filter((a) => matches(query, a)), [props.actions, query]);

  useEffect(() => {
    if (props.open) {
      setQuery("");
      setCursor(0);
      // focus after the veil mounts
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [props.open]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(".palette-item.hot")
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!props.open) return null;

  const runAt = (i: number) => {
    const a = hits[i];
    if (!a) return;
    props.onClose();
    a.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(cursor);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  // group in listed order, preserving action order inside a group
  const groups: { name: string; items: { action: PaletteAction; index: number }[] }[] = [];
  hits.forEach((action, index) => {
    const g = groups.find((x) => x.name === action.group);
    if (g) g.items.push({ action, index });
    else groups.push({ name: action.group, items: [{ action, index }] });
  });

  return (
    <div className="palette-veil" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette" onKeyDown={onKey}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="COMMAND…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          aria-label="Filter commands"
        />
        <ul className="palette-list" ref={listRef}>
          {groups.map((g) => (
            <li key={g.name}>
              <div className="palette-group">{g.name}</div>
              <ul style={{ listStyle: "none" }}>
                {g.items.map(({ action, index }) => (
                  <li key={action.id}>
                    <button
                      className={`palette-item ${index === cursor ? "hot" : ""}`}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => runAt(index)}
                    >
                      <span>{action.label}</span>
                      {action.hint && <span className="pi-hint">{action.hint}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {hits.length === 0 && <li className="palette-empty">NO MATCH — REPHRASE THE ORDER.</li>}
        </ul>
        <div className="palette-foot">
          <span>↑↓ SELECT</span>
          <span>⏎ EXECUTE</span>
          <span>ESC DISMISS</span>
        </div>
      </div>
    </div>
  );
}
