import { searchMemories, type Db } from "@puppetmaster/db";

/**
 * Golden tasks (Stage 5, G7 — τ-bench style). Each task runs against a fresh
 * ephemeral PGlite with the deterministic mock provider, and is graded on:
 *   - outcome: mission succeeded + `expectOutput` predicate
 *   - DB state: `expectState` predicate over the run's database
 *   - trajectory: which tools *must* have been called / *may only* be called
 *     (catches "corrupt success" — right answer via the wrong actions)
 */

export interface GoldenTask {
  id: string;
  description: string;
  kind: "agent" | "workflow";
  /** For agent tasks: the chat message (mock-provider scripted). */
  message?: string;
  /** For workflow tasks: graph + run input. */
  graph?: unknown;
  input?: unknown;
  expectOutput?: (output: unknown) => boolean;
  expectState?: (db: Db, ctx: { workspaceId: string; subjectId: string }) => Promise<boolean>;
  trajectory?: { mustCall?: string[]; mayCallOnly?: string[] };
}

export const GOLDEN_TASKS: GoldenTask[] = [
  {
    id: "agent-tool-echo",
    description: "Agent calls util.echo and reports the result",
    kind: "agent",
    message: 'use util.echo {"value":"golden-probe"}',
    expectOutput: (o) => typeof o === "string" && o.includes("golden-probe"),
    trajectory: { mustCall: ["util.echo"], mayCallOnly: ["util.echo"] },
  },
  {
    id: "agent-remember-fact",
    description: "Agent persists a fact to long-term memory (DB-state grading)",
    kind: "agent",
    message: "remember: the golden retention fact",
    expectState: async (db, ctx) =>
      (await searchMemories(db, ctx.subjectId, "golden retention", 5)).length > 0,
    trajectory: { mustCall: ["memory.save"], mayCallOnly: ["memory.save"] },
  },
  {
    id: "workflow-code-double",
    description: "Workflow code node doubles the numeric input",
    kind: "workflow",
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "c", kind: "code", label: "double", config: { source: "return { doubled: (input.n ?? 0) * 2 };" } },
      ],
      edges: [{ from: "t", to: "c" }],
    },
    input: { n: 21 },
    expectOutput: (o) => (o as { doubled?: number } | null)?.doubled === 42,
  },
  {
    id: "workflow-branch-small",
    description: "Branch routes the small value to the SMALL echo",
    kind: "workflow",
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "c", kind: "code", label: "double", config: { source: "return { doubled: (input.n ?? 0) * 2 };" } },
        { id: "b", kind: "logic", label: "big?", config: { op: "branch", expression: "out.doubled > 5" } },
        { id: "small", kind: "action", label: "small", config: { server: "util", tool: "echo", args: { value: "SMALL" } } },
        { id: "big", kind: "action", label: "big", config: { server: "util", tool: "echo", args: { value: "BIG" } } },
      ],
      edges: [
        { from: "t", to: "c" },
        { from: "c", to: "b" },
        { from: "b", to: "small", condition: "out === false" },
        { from: "b", to: "big", condition: "out === true" },
      ],
    },
    input: { n: 1 },
    expectOutput: (o) => o === "SMALL",
  },
];
