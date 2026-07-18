import type { ClaudeRunResult, ClaudeUsage } from "@puppetmaster/shared";

/** Incremental decoder for Claude Code's newline-delimited stream-json output.
 * Unknown and malformed lines are preserved rather than discarded: CLI schema
 * drift must remain inspectable in the durable event log. */

export interface DecodedClaudeLine {
  raw: string;
  event: Record<string, unknown> | null;
  eventType: string;
  text?: string;
}

export const MAX_CLAUDE_EVENT_LINE_CHARS = 1_000_000;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

export function normalizeClaudeUsage(value: unknown): ClaudeUsage | null {
  const usage = object(value);
  if (!usage) return null;
  return {
    inputTokens: number(usage.input_tokens ?? usage.inputTokens) ?? 0,
    outputTokens: number(usage.output_tokens ?? usage.outputTokens) ?? 0,
    cacheCreationInputTokens:
      number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens) ?? 0,
    cacheReadInputTokens: number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens) ?? 0,
  };
}

/** Normalize only terminal result events. Raw data remains attached so new
 *  Claude Code fields survive until the typed contract catches up. */
export function normalizeClaudeResult(event: unknown): ClaudeRunResult | null {
  const row = object(event);
  if (!row || row.type !== "result") return null;
  const resultText = typeof row.result === "string" ? row.result : null;
  return {
    subtype: typeof row.subtype === "string" ? row.subtype : null,
    result: resultText,
    isError: row.is_error === true,
    stopReason: typeof row.stop_reason === "string" ? row.stop_reason : null,
    totalCostUsd: number(row.total_cost_usd),
    durationMs: number(row.duration_ms),
    durationApiMs: number(row.duration_api_ms),
    numTurns: number(row.num_turns),
    usage: normalizeClaudeUsage(row.usage),
    structuredOutput: row.structured_output ?? null,
    raw: row,
  };
}

/** Best-effort display text without changing the raw payload. */
export function claudeEventText(event: Record<string, unknown>): string | undefined {
  if (typeof event.result === "string") return event.result;
  if (typeof event.message === "string") return event.message;
  const streamEvent = object(event.event);
  const delta = object(streamEvent?.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text;
  if (typeof event.text === "string") return event.text;

  const message = object(event.message);
  if (message) {
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .map((block) => object(block))
      .filter((block): block is Record<string, unknown> => Boolean(block))
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("");
    if (text) return text;
  }
  return undefined;
}

export function claudeEventType(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : "unknown";
  const subtype = typeof event.subtype === "string" ? event.subtype : "";
  if (type === "stream_event") {
    const inner = object(event.event);
    const innerType = typeof inner?.type === "string" ? inner.type : "";
    const delta = object(inner?.delta);
    const deltaType = typeof delta?.type === "string" ? delta.type : "";
    return [type, innerType, deltaType].filter(Boolean).join("/");
  }
  return subtype ? `${type}/${subtype}` : type;
}

export function decodeClaudeLine(raw: string): DecodedClaudeLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (raw.length > MAX_CLAUDE_EVENT_LINE_CHARS) {
    return {
      raw: `${raw.slice(0, MAX_CLAUDE_EVENT_LINE_CHARS)}\n...[oversize event truncated]`,
      event: null,
      eventType: "oversize",
      text: `Claude Code emitted an event larger than ${MAX_CLAUDE_EVENT_LINE_CHARS} characters`,
    };
  }
  try {
    const parsed = object(JSON.parse(trimmed));
    if (!parsed) return { raw, event: null, eventType: "malformed" };
    const text = claudeEventText(parsed);
    return {
      raw,
      event: parsed,
      eventType: claudeEventType(parsed),
      ...(text === undefined ? {} : { text }),
    };
  } catch {
    return { raw, event: null, eventType: "noise", text: trimmed };
  }
}

export class ClaudeJsonLineDecoder {
  private buffer = "";
  private discardingOversize = false;

  push(chunk: string): DecodedClaudeLine[] {
    let input = chunk;
    if (this.discardingOversize) {
      const boundary = input.indexOf("\n");
      if (boundary < 0) return [];
      input = input.slice(boundary + 1);
      this.discardingOversize = false;
    }
    this.buffer += input;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    const decoded = lines.map(decodeClaudeLine).filter((line): line is DecodedClaudeLine => line !== null);
    if (this.buffer.length > MAX_CLAUDE_EVENT_LINE_CHARS) {
      decoded.push({
        raw: `${this.buffer.slice(0, MAX_CLAUDE_EVENT_LINE_CHARS)}\n...[oversize event truncated]`,
        event: null,
        eventType: "oversize",
        text: `Claude Code emitted an event larger than ${MAX_CLAUDE_EVENT_LINE_CHARS} characters`,
      });
      this.buffer = "";
      this.discardingOversize = true;
    }
    return decoded;
  }

  finish(): DecodedClaudeLine[] {
    if (this.discardingOversize) {
      this.discardingOversize = false;
      this.buffer = "";
      return [];
    }
    const tail = this.buffer;
    this.buffer = "";
    const decoded = decodeClaudeLine(tail);
    return decoded ? [decoded] : [];
  }
}
