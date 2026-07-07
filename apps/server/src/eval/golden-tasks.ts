import {
  completeTodo,
  createAgent,
  createProject,
  createVerifyCheck,
  getMission,
  getMissionSteps,
  listArtifacts,
  listApprovals,
  listChildMissions,
  listEvidenceForApproval,
  listEvidenceForStep,
  searchMemories,
  updateArtifact,
  writeArtifact,
  type Db,
} from "@puppetmaster/db";

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
  /** Extra agent settings (Stage 9C pins context compaction behaviour). */
  agent?: { contextCompaction?: boolean };
  /** For workflow tasks: graph + run input. */
  graph?: unknown;
  input?: unknown;
  /** Seed fixture rows before the run; the returned object is merged into the
   *  workflow input so nodes can reference ids via {{input.*}} templating. */
  setup?: (db: Db, ctx: { workspaceId: string }) => Promise<Record<string, unknown>>;
  /** Expected terminal status (default "succeeded") — verify-gate scenarios
   *  legitimately end awaiting_approval or failed. */
  expectStatus?: "succeeded" | "failed" | "awaiting_approval";
  expectOutput?: (output: unknown) => boolean;
  expectState?: (
    db: Db,
    ctx: { workspaceId: string; subjectId: string; missionId: string },
  ) => Promise<boolean>;
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
    id: "agent-compaction-provenance",
    description:
      "Compaction-enabled agent sees the compacted tool result while the step keeps the raw output",
    kind: "agent",
    agent: { contextCompaction: true },
    // 60 identical lines (~1.6k chars): above the compaction threshold, so the
    // context copy collapses to one line with a ×60 marker, which the mock
    // provider then quotes back in its summary.
    message: `use util.echo ${JSON.stringify({ value: "repeated log line for compaction\n".repeat(60) })}`,
    expectOutput: (o) => typeof o === "string" && o.includes("[×60]"),
    // Provenance: the mission step must hold the RAW result — full length, no
    // compaction markers.
    expectState: async (db, ctx) => {
      const steps = await getMissionSteps(db, ctx.missionId);
      const raw = steps.find((s) => s.kind === "action" && s.nodeId === "util__echo")?.output;
      return typeof raw === "string" && raw.length > 1500 && !raw.includes("[×");
    },
    trajectory: { mustCall: ["util.echo"], mayCallOnly: ["util.echo"] },
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
  {
    id: "workshop-artifact-lifecycle",
    description:
      "Workshop WP2: a workflow writes a spec artifact and completes a todo with the mission link; repo-layer lifecycle rules hold (accepted ADRs immutable, no mission-less completion)",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, {
        workspaceId: ctx.workspaceId,
        name: "eval-workshop",
        mode: "supervised",
      });
      const todo = await writeArtifact(db, {
        projectId: project.id,
        kind: "todo",
        title: "build the first increment",
        status: "active",
      });
      return { projectId: project.id, todoId: todo.id };
    },
    graph: {
      // Node ids follow the agent-runtime convention (server__tool) so the
      // harness's trajectory extraction sees real tool identities.
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        {
          id: "project__artifact.write",
          kind: "action",
          label: "write spec",
          config: {
            server: "project",
            tool: "artifact.write",
            args: { projectId: "{{input.projectId}}", kind: "spec", title: "Spec", body: "the declared shape" },
          },
        },
        {
          id: "project__todo.complete",
          kind: "action",
          label: "complete todo",
          config: {
            server: "project",
            tool: "todo.complete",
            args: { todoId: "{{input.todoId}}" },
          },
        },
      ],
      edges: [
        { from: "t", to: "project__artifact.write" },
        // Input resolution takes the first satisfied edge's upstream output —
        // the trigger edge (declared first) hands the payload with {{input.todoId}}
        // to the complete node; the second edge only enforces ordering.
        { from: "t", to: "project__todo.complete" },
        { from: "project__artifact.write", to: "project__todo.complete" },
      ],
    },
    expectState: async (db, ctx) => {
      // Recover the project via the fixture name — setup ran in this same DB.
      const { listProjects } = await import("@puppetmaster/db");
      const project = (await listProjects(db, ctx.workspaceId)).find((p) => p.name === "eval-workshop");
      if (!project) return false;

      // 1. The spec artifact exists at version 1.
      const specs = await listArtifacts(db, project.id, { kind: "spec" });
      if (specs.length !== 1 || specs[0]!.version !== 1) return false;

      // 2. The todo is completed AND linked to the completing mission.
      const todos = await listArtifacts(db, project.id, { kind: "todo" });
      const todo = todos[0];
      if (!todo || todo.status !== "completed" || todo.missionId !== ctx.missionId) return false;

      // 3. Spec re-write is a NEW version superseding v1, not an edit.
      const v2 = await writeArtifact(db, { projectId: project.id, kind: "spec", title: "Spec", body: "revised" });
      if (v2.version !== 2 || v2.supersedesId !== specs[0]!.id) return false;

      // 4. Negative: an accepted ADR refuses direct edits (immutable).
      const adr = await writeArtifact(db, {
        projectId: project.id,
        kind: "adr",
        title: "ADR-001: fixture",
        status: "accepted",
      });
      const adrEditRejected = await updateArtifact(db, adr.id, { body: "tamper" }).then(
        () => false,
        () => true,
      );
      if (!adrEditRejected) return false;

      // 5. Negative: completing a todo without a mission id refuses.
      const orphan = await writeArtifact(db, {
        projectId: project.id,
        kind: "todo",
        title: "orphan",
        status: "active",
      });
      const orphanRejected = await completeTodo(db, orphan.id, "").then(
        () => false,
        () => true,
      );
      return orphanRejected;
    },
    trajectory: {
      mustCall: ["project.artifact.write", "project.todo.complete"],
      mayCallOnly: ["project.artifact.write", "project.todo.complete"],
    },
  },
  {
    id: "workshop-verify-gate-pass",
    description:
      "Workshop WP4: an in-sync project passes the todo-sync verify gate; evidence is persisted on the step and the gated action runs",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-gate-pass" });
      await writeArtifact(db, { projectId: project.id, kind: "spec", title: "Spec", body: "v1" });
      await new Promise((r) => setTimeout(r, 15));
      await writeArtifact(db, { projectId: project.id, kind: "todo", title: "task", status: "active" });
      await createVerifyCheck(db, { projectId: project.id, name: "todo-sync", enabled: true, earnedNote: "eval fixture" });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "todo-sync gate", config: { projectId: "{{input.projectId}}", check: "todo-sync" } },
        { id: "util__echo", kind: "action", label: "gated work", config: { server: "util", tool: "echo", args: { value: "gated-ok" } } },
      ],
      edges: [
        { from: "t", to: "gate" },
        { from: "gate", to: "util__echo" },
      ],
    },
    expectOutput: (o) => o === "gated-ok",
    expectState: async (db, ctx) => {
      const steps = await getMissionSteps(db, ctx.missionId);
      const gate = steps.find((s) => s.kind === "verify");
      if (!gate || gate.status !== "succeeded") return false;
      const out = gate.output as { passed?: boolean; check?: string } | null;
      if (out?.passed !== true || out?.check !== "todo-sync") return false;
      const ev = await listEvidenceForStep(db, gate.id);
      return ev.length === 1 && ev[0]!.kind === "state-assert";
    },
    trajectory: { mustCall: ["util.echo"], mayCallOnly: ["util.echo"] },
  },
  {
    id: "workshop-verify-gate-escalates",
    description:
      "Workshop WP4: an out-of-sync project fails the todo-sync gate with no fix agent — the mission pauses on an escalation approval carrying evidence; the gated action never runs",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-gate-block" });
      await writeArtifact(db, { projectId: project.id, kind: "todo", title: "stale task", status: "active" });
      await new Promise((r) => setTimeout(r, 15));
      await writeArtifact(db, { projectId: project.id, kind: "spec", title: "Spec", body: "changed after todos" });
      await createVerifyCheck(db, { projectId: project.id, name: "todo-sync", enabled: true, earnedNote: "eval fixture" });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "todo-sync gate", config: { projectId: "{{input.projectId}}", check: "todo-sync" } },
        { id: "util__echo", kind: "action", label: "gated work", config: { server: "util", tool: "echo", args: { value: "should-not-run" } } },
      ],
      edges: [
        { from: "t", to: "gate" },
        { from: "gate", to: "util__echo" },
      ],
    },
    expectStatus: "awaiting_approval",
    expectState: async (db, ctx) => {
      const approval = (await listApprovals(db, "pending")).find(
        (a: { missionId: string }) => a.missionId === ctx.missionId,
      );
      if (!approval || !approval.prompt.includes("todo-sync")) return false;
      const ev = await listEvidenceForApproval(db, approval.id);
      if (ev.length !== 1) return false;
      const content = ev[0]!.content as { runs?: unknown[] } | null;
      return Array.isArray(content?.runs) && content!.runs!.length === 1;
    },
    trajectory: { mayCallOnly: [] },
  },
  {
    id: "workshop-verify-fix-loop-bounded",
    description:
      "Workshop WP4: a failing gate with a fix agent runs the bounded loop — N check attempts, N-1 nested fix missions with the failure instruction — then escalates with the full run history as evidence",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-gate-loop" });
      await writeArtifact(db, { projectId: project.id, kind: "todo", title: "stale task", status: "active" });
      await new Promise((r) => setTimeout(r, 15));
      await writeArtifact(db, { projectId: project.id, kind: "spec", title: "Spec", body: "changed after todos" });
      await createVerifyCheck(db, { projectId: project.id, name: "todo-sync", enabled: true, earnedNote: "eval fixture" });
      // The mock provider replies with text (it cannot act on the multi-sentence
      // instruction) — deliberately: this pins the LOOP and the ESCALATION, not
      // a scripted fix. The full fix-recovery e2e lands with WP5's executor.
      const fixer = await createAgent(db, {
        workspaceId: ctx.workspaceId,
        name: "eval-fixer",
        persona: "You fix verify-gate failures.",
        model: "mock",
      });
      return { projectId: project.id, fixAgentId: fixer.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        {
          id: "gate",
          kind: "verify",
          label: "todo-sync gate",
          config: {
            projectId: "{{input.projectId}}",
            check: "todo-sync",
            fixAgentId: "{{input.fixAgentId}}",
            retriesBeforeEscalate: 2,
          },
        },
      ],
      edges: [{ from: "t", to: "gate" }],
    },
    expectStatus: "awaiting_approval",
    expectState: async (db, ctx) => {
      // Bounded loop shape: 2 check attempts -> exactly 1 nested fix mission.
      const children = await listChildMissions(db, ctx.missionId);
      if (children.length !== 1) return false;
      const approval = (await listApprovals(db, "pending")).find(
        (a: { missionId: string }) => a.missionId === ctx.missionId,
      );
      if (!approval || !approval.prompt.includes("after 2 attempt(s)")) return false;
      const ev = await listEvidenceForApproval(db, approval.id);
      const content = ev[0]?.content as { runs?: { fixMissionId?: string }[] } | null;
      return (
        Array.isArray(content?.runs) &&
        content!.runs!.length === 2 &&
        content!.runs![0]!.fixMissionId === children[0]!.id
      );
    },
  },
  {
    id: "workshop-verify-disabled-fails-closed",
    description:
      "Workshop WP4: gating on a disabled check fails the mission loudly (earned policies are off by default; absence must never pass)",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-gate-disabled" });
      await createVerifyCheck(db, { projectId: project.id, name: "todo-sync", enabled: false });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "gate", config: { projectId: "{{input.projectId}}", check: "todo-sync" } },
      ],
      edges: [{ from: "t", to: "gate" }],
    },
    expectStatus: "failed",
    expectState: async (db, ctx) => {
      const mission = await getMission(db, ctx.missionId);
      return Boolean(mission?.error?.includes("disabled"));
    },
  },
];
