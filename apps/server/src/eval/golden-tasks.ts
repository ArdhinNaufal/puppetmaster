import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localWorkbenchDir } from "@puppetmaster/kernel";
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
  listDocuments,
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
  {
    id: "workshop-spec-gate-theater-refusal",
    description:
      "Workshop WP5a: the spec-sections gate refuses a vague spec (missing/thin sections) and escalates with the section list as evidence — the theater detector as a deterministic check",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-spec-theater" });
      await writeArtifact(db, {
        projectId: project.id,
        kind: "spec",
        title: "Spec",
        body: "## Tech stack\nnode\n## Code architecture\nclean separation of concerns",
      });
      await createVerifyCheck(db, { projectId: project.id, name: "spec-sections", enabled: true, earnedNote: "eval fixture" });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "spec gate", config: { projectId: "{{input.projectId}}", check: "spec-sections" } },
      ],
      edges: [{ from: "t", to: "gate" }],
    },
    expectStatus: "awaiting_approval",
    expectState: async (db, ctx) => {
      const approval = (await listApprovals(db, "pending")).find(
        (a: { missionId: string }) => a.missionId === ctx.missionId,
      );
      if (!approval || !approval.prompt.includes("spec-sections")) return false;
      const ev = await listEvidenceForApproval(db, approval.id);
      const detail = (ev[0]?.content as { detail?: { missing?: string[]; thin?: string[] } } | null)?.detail;
      // "Data model" etc. never appeared; "Tech stack" appeared but is thin.
      return (
        Array.isArray(detail?.missing) &&
        detail!.missing!.includes("Data model") &&
        Array.isArray(detail?.thin) &&
        detail!.thin!.includes("Tech stack")
      );
    },
  },
  {
    id: "workshop-spec-gate-pass-and-kb-mirror",
    description:
      "Workshop WP5a: a concrete spec passes the spec-sections gate; each version is mirrored into the KB exactly once (ADR-004 — one live mirror per artifact, replaced on re-write)",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-spec-mirror" });
      await createVerifyCheck(db, { projectId: project.id, name: "spec-sections", enabled: true, earnedNote: "eval fixture" });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        {
          id: "w1",
          kind: "action",
          label: "write spec v1",
          config: {
            server: "project",
            tool: "artifact.write",
            args: { projectId: "{{input.projectId}}", kind: "spec", title: "Spec", body: "## Tech stack\nNode 22, Fastify, Postgres with pgvector, Redis, React with Vite frontend.\n## Data model\nOne table of widgets (id, name, state) plus an audit trail of every mutation.\n## Code architecture\napi -> services -> data; nothing imports api; no cycles; max 400 lines per file.\n## Scale & operations\n~50 concurrent users at launch, 12-month growth to ~200. SLO: none - best effort.\n## Edge cases\nDuplicate widget names are rejected; concurrent edits use last-write-wins with audit.\n## Out of scope\nNo multi-tenancy, no mobile app, no offline mode in this iteration.\n## Verification\nRun the suite; create/edit/delete a widget through the UI and see the audit entries." },
          },
        },
        {
          id: "w2",
          kind: "action",
          label: "write spec v2",
          config: {
            server: "project",
            tool: "artifact.write",
            args: { projectId: "{{input.projectId}}", kind: "spec", title: "Spec", body: "## Tech stack\nNode 22, Fastify, Postgres with pgvector, Redis, React with Vite frontend.\n## Data model\nOne table of widgets (id, name, state) plus an audit trail of every mutation.\n## Code architecture\napi -> services -> data; nothing imports api; no cycles; max 400 lines per file.\n## Scale & operations\n~50 concurrent users at launch, 12-month growth to ~200. SLO: none - best effort.\n## Edge cases\nDuplicate widget names are rejected; concurrent edits use last-write-wins with audit.\n## Out of scope\nNo multi-tenancy, no mobile app, no offline mode in this iteration.\n## Verification\nRun the suite; create/edit/delete a widget through the UI and see the audit entries.\n## Revision\nSecond pass after review." },
          },
        },
        { id: "gate", kind: "verify", label: "spec gate", config: { projectId: "{{input.projectId}}", check: "spec-sections" } },
      ],
      edges: [
        // Payload-input trick (see learnings.md): the trigger edge declared
        // first hands each node the mission payload; the chain edges order.
        { from: "t", to: "w1" },
        { from: "t", to: "w2" },
        { from: "w1", to: "w2" },
        { from: "t", to: "gate" },
        { from: "w2", to: "gate" },
      ],
    },
    expectOutput: (o) => (o as { passed?: boolean } | null)?.passed === true,
    expectState: async (db, ctx) => {
      const { listProjects: lp } = await import("@puppetmaster/db");
      const project = (await lp(db, ctx.workspaceId)).find((p) => p.name === "eval-spec-mirror");
      if (!project) return false;
      const specs = await listArtifacts(db, project.id, { kind: "spec" });
      if (specs.length !== 2) return false;
      // Exactly ONE live KB mirror, and it is the newest version.
      const source = `project:${project.id}:spec:Spec`;
      const mirrors = (await listDocuments(db, ctx.workspaceId)).filter((d) => d.source === source);
      return mirrors.length === 1 && mirrors[0]!.title.includes("(v2)") && mirrors[0]!.chunkCount > 0;
    },
  },
  {
    id: "workshop-test-check-pass-local",
    description:
      "Workshop WP3a: a project's `test` check runs `node --test` in the local workbench; passing → the gate opens, evidence is captured, the gated action runs",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-test-pass" });
      await createVerifyCheck(db, {
        projectId: project.id,
        name: "test",
        command: "node --test",
        enabled: true,
        earnedNote: "eval fixture",
      });
      const dir = localWorkbenchDir(project.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "add.mjs"), "export function add(a, b) { return a + b; }\n");
      writeFileSync(
        join(dir, "add.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "./add.mjs";\ntest("add", () => assert.strictEqual(add(2, 3), 5));\n',
      );
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "test gate", config: { projectId: "{{input.projectId}}", check: "test" } },
        { id: "util__echo", kind: "action", label: "gated", config: { server: "util", tool: "echo", args: { value: "gated-ok" } } },
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
      if (out?.passed !== true || out?.check !== "test") return false;
      const ev = await listEvidenceForStep(db, gate.id);
      return ev.length === 1 && ev[0]!.kind === "test-output";
    },
    trajectory: { mustCall: ["util.echo"], mayCallOnly: ["util.echo"] },
  },
  {
    id: "workshop-test-check-blocks-local",
    description:
      "Workshop WP3a: a failing `node --test` in the local workbench gates the mission — it escalates with the command output as evidence; the gated action never runs",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-test-blocks" });
      await createVerifyCheck(db, {
        projectId: project.id,
        name: "test",
        command: "node --test",
        enabled: true,
        earnedNote: "eval fixture",
      });
      const dir = localWorkbenchDir(project.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "add.mjs"), "export function add(a, b) { return a - b; }\n"); // BUG
      writeFileSync(
        join(dir, "add.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "./add.mjs";\ntest("add", () => assert.strictEqual(add(2, 3), 5));\n',
      );
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "test gate", config: { projectId: "{{input.projectId}}", check: "test" } },
        { id: "util__echo", kind: "action", label: "gated", config: { server: "util", tool: "echo", args: { value: "should-not-run" } } },
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
      if (!approval || !approval.prompt.includes("test")) return false;
      const ev = await listEvidenceForApproval(db, approval.id);
      const detail = (ev[0]?.content as { runs?: { summary: string }[]; detail?: { code?: number } } | null);
      // The escalation evidence carries the failing run; the gated echo never ran.
      const steps = await getMissionSteps(db, ctx.missionId);
      const echo = steps.find((s) => s.nodeId === "util__echo");
      const ranEcho = echo?.status === "succeeded";
      return Array.isArray(detail?.runs) && detail!.runs!.length >= 1 && !ranEcho;
    },
  },
  {
    id: "bench-write-read-roundtrip-local",
    description:
      "Workshop WP3b.3: bench.write then bench.read round-trip a file through the workbench executor — the write/read tools drive real commands, content survives byte-for-byte",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-bench-rw" });
      const dir = localWorkbenchDir(project.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        {
          id: "bench__write",
          kind: "action",
          label: "write",
          config: {
            server: "bench",
            tool: "write",
            args: { projectId: "{{input.projectId}}", path: "note.txt", content: "hello-bench" },
          },
        },
        {
          id: "bench__read",
          kind: "action",
          label: "read",
          config: {
            server: "bench",
            tool: "read",
            args: { projectId: "{{input.projectId}}", path: "note.txt" },
          },
        },
      ],
      // The direct trigger→read edge (declared before write→read) makes read's
      // input the payload (with projectId); write→read enforces ordering. Idiom
      // per learnings.md: input resolves against the first satisfied edge.
      edges: [
        { from: "t", to: "bench__write" },
        { from: "t", to: "bench__read" },
        { from: "bench__write", to: "bench__read" },
      ],
    },
    expectOutput: (o) => o === "hello-bench",
    trajectory: { mustCall: ["bench.write", "bench.read"], mayCallOnly: ["bench.write", "bench.read"] },
  },
  {
    id: "bench-exec-git-status-local",
    description:
      "Workshop WP3b.3: bench.exec runs a shell command in the workbench and bench.git.status reads its git state — exec + git tools construct and run real commands, exit code and porcelain output flow back",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-bench-git" });
      const dir = localWorkbenchDir(project.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        {
          id: "bench__exec",
          kind: "action",
          label: "exec",
          config: {
            server: "bench",
            tool: "exec",
            args: {
              projectId: "{{input.projectId}}",
              command: "git init -q && printf hi > tracked.txt && git add -A",
            },
          },
        },
        {
          id: "bench__git.status",
          kind: "action",
          label: "status",
          config: { server: "bench", tool: "git.status", args: { projectId: "{{input.projectId}}" } },
        },
      ],
      edges: [
        { from: "t", to: "bench__exec" },
        { from: "t", to: "bench__git.status" },
        { from: "bench__exec", to: "bench__git.status" },
      ],
    },
    expectOutput: (o) => {
      const r = o as { code?: number; stdout?: string } | null;
      return r?.code === 0 && typeof r?.stdout === "string" && r.stdout.includes("tracked.txt");
    },
    trajectory: { mustCall: ["bench.exec", "bench.git.status"], mayCallOnly: ["bench.exec", "bench.git.status"] },
  },
  {
    id: "bench-write-gated",
    description:
      "Workshop WP3b.3: bench.write is write-tier — an agent's call pauses for approval before touching the workbench; the mutation never auto-runs",
    kind: "agent",
    message: 'use bench.write {"projectId":"p","path":"x.txt","content":"y"}',
    expectStatus: "awaiting_approval",
    expectState: async (db, ctx) => {
      const approval = (await listApprovals(db, "pending")).find(
        (a: { missionId: string }) => a.missionId === ctx.missionId,
      );
      return (
        !!approval &&
        (approval as { tier: string }).tier === "write_approved" &&
        approval.prompt.includes("bench.write")
      );
    },
    // Nothing executed: the tick paused at the tier gate before the tool ran.
    trajectory: { mayCallOnly: [] },
  },
  {
    id: "bench-push-gated",
    description:
      "Workshop WP3b.3: bench.git.push is destructive — an agent's call always pauses for confirmation (the corpus's injection→push gate)",
    kind: "agent",
    message: 'use bench.git.push {"projectId":"p"}',
    expectStatus: "awaiting_approval",
    expectState: async (db, ctx) => {
      const approval = (await listApprovals(db, "pending")).find(
        (a: { missionId: string }) => a.missionId === ctx.missionId,
      );
      return (
        !!approval &&
        (approval as { tier: string }).tier === "destructive_confirmed" &&
        approval.prompt.includes("bench.git.push")
      );
    },
    trajectory: { mayCallOnly: [] },
  },
  {
    id: "bench-delegate-gated",
    description:
      "Workshop WP3b.4: bench.delegate (the pinned coding CLI inside the workbench, ADR-002) is write-tier — an agent's call pauses for approval before the CLI runs; delegation never auto-executes",
    kind: "agent",
    message: 'use bench.delegate {"projectId":"p","task":"add a comment to add.mjs"}',
    expectStatus: "awaiting_approval",
    expectState: async (db, ctx) => {
      const approval = (await listApprovals(db, "pending")).find(
        (a: { missionId: string }) => a.missionId === ctx.missionId,
      );
      return (
        !!approval &&
        (approval as { tier: string }).tier === "write_approved" &&
        approval.prompt.includes("bench.delegate")
      );
    },
    // Nothing executed: the tick paused at the tier gate before the CLI ran.
    trajectory: { mayCallOnly: [] },
  },
  {
    id: "refactor-gate-blocks-test-edit-local",
    description:
      "Workshop WP3b.6: the refactor-gate blocks a run that modifies an existing test file (editing test expectations to make refactored code pass — failure mode P14) — it escalates with the modified-test list as evidence; the gated action never runs",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-refactor-blocks" });
      await createVerifyCheck(db, { projectId: project.id, name: "refactor-gate", enabled: true, earnedNote: "eval fixture" });
      const dir = localWorkbenchDir(project.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "src.mjs"), "export const f = () => 1;\n");
      writeFileSync(join(dir, "src.test.mjs"), "import assert from 'node:assert';\nassert.ok(true);\n");
      execSync(
        "git init -q && git config user.email e@x.dev && git config user.name eval && git add -A && git commit -q -m baseline",
        { cwd: dir },
      );
      // The refactor edits the TEST file — the smell the gate exists to catch.
      writeFileSync(join(dir, "src.test.mjs"), "import assert from 'node:assert';\nassert.ok(true); // edited expectation\n");
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "refactor gate", config: { projectId: "{{input.projectId}}", check: "refactor-gate" } },
        { id: "util__echo", kind: "action", label: "gated", config: { server: "util", tool: "echo", args: { value: "should-not-run" } } },
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
      if (!approval || !approval.prompt.includes("refactor-gate")) return false;
      const ev = await listEvidenceForApproval(db, approval.id);
      const content = ev[0]?.content as { detail?: { modifiedTests?: string[] } } | null;
      const mods = content?.detail?.modifiedTests;
      if (!Array.isArray(mods) || !mods.includes("src.test.mjs")) return false;
      const steps = await getMissionSteps(db, ctx.missionId);
      return steps.find((s) => s.nodeId === "util__echo")?.status !== "succeeded";
    },
  },
  {
    id: "refactor-gate-passes-added-test-local",
    description:
      "Workshop WP3b.6: the refactor-gate passes a run that changes source and only ADDS a test file (behavior-preserving; additions are not modifications) — the gate opens and the gated action runs",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-refactor-pass" });
      await createVerifyCheck(db, { projectId: project.id, name: "refactor-gate", enabled: true, earnedNote: "eval fixture" });
      const dir = localWorkbenchDir(project.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "src.mjs"), "export const f = () => 1;\n");
      writeFileSync(join(dir, "src.test.mjs"), "import assert from 'node:assert';\nassert.ok(true);\n");
      execSync(
        "git init -q && git config user.email e@x.dev && git config user.name eval && git add -A && git commit -q -m baseline",
        { cwd: dir },
      );
      // Behaviour-preserving: source changes, and a NEW test is added (not edited).
      writeFileSync(join(dir, "src.mjs"), "export const f = () => 1; // refactored\n");
      writeFileSync(join(dir, "new.test.mjs"), "import assert from 'node:assert';\nassert.ok(true);\n");
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "refactor gate", config: { projectId: "{{input.projectId}}", check: "refactor-gate" } },
        { id: "util__echo", kind: "action", label: "gated", config: { server: "util", tool: "echo", args: { value: "gated-ok" } } },
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
      return out?.passed === true && out?.check === "refactor-gate";
    },
    trajectory: { mustCall: ["util.echo"], mayCallOnly: ["util.echo"] },
  },
  {
    id: "load-refuses-without-slos-local",
    description:
      "Workshop WP3b.6: the load check fails the mission loudly when no SLO thresholds are declared (failure mode S2 — an invented threshold is the smell; never pass by absence)",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-load-no-slo" });
      await createVerifyCheck(db, { projectId: project.id, name: "load", enabled: true, earnedNote: "eval fixture" });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "load gate", config: { projectId: "{{input.projectId}}", check: "load" } },
      ],
      edges: [{ from: "t", to: "gate" }],
    },
    expectStatus: "failed",
    expectState: async (db, ctx) => {
      const mission = await getMission(db, ctx.missionId);
      return Boolean(mission?.error?.includes("SLO"));
    },
  },
  {
    id: "load-passes-with-slos-local",
    description:
      "Workshop WP3b.6: the load check with declared SLOs runs its configured command in the workbench; exit 0 = the SLOs held → the gate opens and the gated action runs",
    kind: "workflow",
    setup: async (db, ctx) => {
      const project = await createProject(db, { workspaceId: ctx.workspaceId, name: "eval-load-pass" });
      await createVerifyCheck(db, {
        projectId: project.id,
        name: "load",
        command: JSON.stringify({ slos: [{ name: "p95_ms", max: 200 }], run: "true" }),
        enabled: true,
        earnedNote: "eval fixture",
      });
      const dir = localWorkbenchDir(project.id);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      return { projectId: project.id };
    },
    graph: {
      nodes: [
        { id: "t", kind: "trigger", label: "go", config: { mode: "manual" } },
        { id: "gate", kind: "verify", label: "load gate", config: { projectId: "{{input.projectId}}", check: "load" } },
        { id: "util__echo", kind: "action", label: "gated", config: { server: "util", tool: "echo", args: { value: "gated-ok" } } },
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
      const ev = await listEvidenceForStep(db, gate.id);
      return ev.length === 1 && ev[0]!.kind === "test-output";
    },
    trajectory: { mustCall: ["util.echo"], mayCallOnly: ["util.echo"] },
  },
];
