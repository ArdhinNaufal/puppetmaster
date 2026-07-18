import { z } from "zod";

/** Provider account and coding backend are independent, immutable session axes. */
export const CodingProvider = z.enum(["anthropic", "openai"]);
export type CodingProvider = z.infer<typeof CodingProvider>;

export const CodingBackend = z.enum(["claude", "aider"]);
export type CodingBackend = z.infer<typeof CodingBackend>;

/**
 * Claude Code execution contracts. `bypassPermissions` is intentionally not
 * represented: Puppetmaster always retains an outer approval/isolation layer.
 */
export const ClaudePermissionMode = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "auto",
]);
export type ClaudePermissionMode = z.infer<typeof ClaudePermissionMode>;

export const ClaudeEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ClaudeEffort = z.infer<typeof ClaudeEffort>;

/** A turn's product mode; it is separate from the CLI permission mode. */
export const ClaudeRunMode = z.enum(["plan", "execute"]);
export type ClaudeRunMode = z.infer<typeof ClaudeRunMode>;

export const ClaudeSessionStatus = z.enum(["active", "archived"]);
export type ClaudeSessionStatus = z.infer<typeof ClaudeSessionStatus>;

export const ClaudeRunStatus = z.enum([
  "queued",
  "awaiting_approval",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type ClaudeRunStatus = z.infer<typeof ClaudeRunStatus>;

export const ClaudeEventStream = z.enum(["stdout", "stderr", "system"]);
export type ClaudeEventStream = z.infer<typeof ClaudeEventStream>;

/**
 * Snapshot of the CLI controls used for a turn. Unknown future CLI settings
 * belong in `extra`, allowing the persisted contract to survive schema drift.
 */
export const ClaudeRunConfig = z.object({
  model: z.string().trim().min(1),
  effort: ClaudeEffort.nullable().default(null),
  permissionMode: ClaudePermissionMode,
  maxTurns: z.number().int().positive().nullable().default(null),
  maxBudgetUsd: z.number().finite().nonnegative().nullable().default(null),
  allowedTools: z.array(z.string().trim().min(1)).default([]),
  disallowedTools: z.array(z.string().trim().min(1)).default([]),
  additionalDirectories: z.array(z.string().trim().min(1)).default([]),
  extra: z.record(z.unknown()).default({}),
});
export type ClaudeRunConfig = z.infer<typeof ClaudeRunConfig>;

/** Token accounting emitted by Claude Code's terminal result event. */
export const ClaudeUsage = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    cacheCreationInputTokens: z.number().int().nonnegative().default(0),
    cacheReadInputTokens: z.number().int().nonnegative().default(0),
  })
  .passthrough();
export type ClaudeUsage = z.infer<typeof ClaudeUsage>;

/** Normalized terminal result while retaining the raw event for diagnostics. */
export const ClaudeRunResult = z.object({
  subtype: z.string().nullable().default(null),
  result: z.string().nullable().default(null),
  isError: z.boolean().default(false),
  stopReason: z.string().nullable().default(null),
  totalCostUsd: z.number().finite().nonnegative().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  durationApiMs: z.number().int().nonnegative().nullable().default(null),
  numTurns: z.number().int().nonnegative().nullable().default(null),
  usage: ClaudeUsage.nullable().default(null),
  structuredOutput: z.unknown().nullable().default(null),
  raw: z.unknown().nullable().default(null),
});
export type ClaudeRunResult = z.infer<typeof ClaudeRunResult>;

export const ClaudeSession = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  provider: CodingProvider.default("anthropic"),
  backend: CodingBackend.default("claude"),
  title: z.string().trim().min(1),
  /** Session id assigned by the Claude Code CLI after its first init event. */
  claudeSessionId: z.string().trim().min(1).nullable().default(null),
  status: ClaudeSessionStatus,
  model: z.string().trim().min(1),
  effort: ClaudeEffort.nullable().default(null),
  permissionMode: ClaudePermissionMode,
  config: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ClaudeSession = z.infer<typeof ClaudeSession>;

export const ClaudeRun = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  missionId: z.string().uuid(),
  provider: CodingProvider.default("anthropic"),
  backend: CodingBackend.default("claude"),
  turnNumber: z.number().int().positive(),
  mode: ClaudeRunMode,
  prompt: z.string().min(1),
  status: ClaudeRunStatus,
  executionGeneration: z.number().int().nonnegative().default(0),
  model: z.string().trim().min(1),
  effort: ClaudeEffort.nullable().default(null),
  permissionMode: ClaudePermissionMode,
  config: z.record(z.unknown()).default({}),
  result: ClaudeRunResult.nullable().default(null),
  resultText: z.string().nullable().default(null),
  isError: z.boolean().nullable().default(null),
  usage: ClaudeUsage.nullable().default(null),
  costUsd: z.number().finite().nonnegative().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  durationApiMs: z.number().int().nonnegative().nullable().default(null),
  numTurns: z.number().int().nonnegative().nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: z.coerce.date().nullable().default(null),
  finishedAt: z.coerce.date().nullable().default(null),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ClaudeRun = z.infer<typeof ClaudeRun>;

/**
 * One bounded process line plus its best-effort decoded payload. Malformed,
 * noisy, and oversize records remain visible without allowing an unbounded
 * process line to exhaust the server or database.
 */
export const ClaudeEvent = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  runId: z.string().uuid(),
  sequence: z.number().int().positive(),
  stream: ClaudeEventStream,
  eventType: z.string().trim().min(1),
  raw: z.string(),
  payload: z.unknown().nullable().default(null),
  createdAt: z.coerce.date(),
});
export type ClaudeEvent = z.infer<typeof ClaudeEvent>;
