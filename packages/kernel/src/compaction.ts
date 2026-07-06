/**
 * Tool-output compaction (Stage 9C, docs/9ROUTER-ADOPTION.md — RTK, with
 * provenance). Deterministic, model-free text passes shrink large tool
 * results before they enter agent context; the RAW output always stays in
 * the mission step, and the audit entry records what was compacted. Applied
 * only when the agent opted in (`agents.context_compaction`).
 */

export interface CompactionOptions {
  /** Results smaller than this (chars) are never touched. */
  minChars: number;
  /** Hard context cap: anything longer after the soft passes is truncated. */
  maxChars: number;
}

export const COMPACTION_DEFAULTS: CompactionOptions = {
  minChars: 800,
  maxChars: 4000,
};

export interface CompactionOutcome {
  /** Replacement payload for model context (always a string). */
  result: string;
  /** Passes that actually shrank the text, in application order. */
  compactors: string[];
  rawBytes: number;
  sentBytes: number;
}

/** Pretty-printed JSON → compact JSON. */
function passJsonCompact(text: string): string {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return text;
  try {
    return JSON.stringify(JSON.parse(t));
  } catch {
    return text;
  }
}

/** Strip trailing whitespace per line; collapse runs of blank lines to one. */
function passWhitespace(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Consecutive identical lines (3+) collapse to one line with a ×N marker. */
function passDedupLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j++;
    const run = j - i + 1;
    if (run >= 3 && lines[i]!.trim().length > 0) {
      out.push(`${lines[i]} [×${run}]`);
    } else {
      for (let k = i; k <= j; k++) out.push(lines[k]!);
    }
    i = j + 1;
  }
  return out.join("\n");
}

/** Head/tail smart-truncate with an explicit elision marker. */
function passTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.floor(maxChars * 0.25);
  const elided = text.length - head - tail;
  return `${text.slice(0, head)}\n… [compacted: ${elided} chars elided] …\n${text.slice(text.length - tail)}`;
}

/**
 * Compact a tool result for model context. Returns null when the result is
 * below the threshold or no pass produced a real saving — the caller then
 * sends the original untouched.
 */
export function compactForContext(
  value: unknown,
  opts: Partial<CompactionOptions> = {},
): CompactionOutcome | null {
  const { minChars, maxChars } = { ...COMPACTION_DEFAULTS, ...opts };
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (typeof raw !== "string" || raw.length < minChars) return null;

  const compactors: string[] = [];
  let text = raw;
  for (const [name, pass] of [
    ["json-compact", passJsonCompact],
    ["whitespace", passWhitespace],
    ["dedup-lines", passDedupLines],
  ] as const) {
    const next = pass(text);
    if (next.length < text.length) {
      compactors.push(name);
      text = next;
    }
  }
  if (text.length > maxChars) {
    text = passTruncate(text, maxChars);
    compactors.push("truncate");
  }

  const rawBytes = Buffer.byteLength(raw, "utf8");
  const sentBytes = Buffer.byteLength(text, "utf8");
  if (compactors.length === 0 || sentBytes >= rawBytes) return null;
  return { result: text, compactors, rawBytes, sentBytes };
}
