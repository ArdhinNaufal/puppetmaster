import {
  completeTodo,
  deleteDocument,
  getArtifact,
  getProject,
  listArtifacts,
  listDocuments,
  listProjects,
  nextTodo,
  writeArtifact,
  type Db,
} from "@puppetmaster/db";
import { kbIngest, type KbDeps } from "./kb.js";
import type { BuiltinToolRegistry } from "./tools.js";

/**
 * Workshop tools (AI-SDLC plan WP2): project artifacts and todos on the
 * shared catalog, so agents and workflow action nodes use the same surface
 * (one-catalog rule, ARCHITECTURE.md §3.4). Reads are read_auto; artifact
 * writes and todo completion are write_approved (PRD §4 tiers). Lifecycle
 * rules are enforced by the repo layer, not here.
 */

/** ADR-004: accepted knowledge artifacts are mirrored into the KB so
 *  `kb.search` retrieval and citations work over them. The artifact row stays
 *  the source of truth; the mirror is replaced on every new version (one KB
 *  document per project+kind+title, keyed by `source`). Spec + learning for
 *  now; ADR-on-accept rides the WP5 record phase. */
export async function mirrorArtifactToKb(
  kb: KbDeps,
  artifact: { projectId: string; kind: string; title: string; body: string; version: number },
): Promise<void> {
  if (artifact.kind !== "spec" && artifact.kind !== "learning") return;
  const source = `project:${artifact.projectId}:${artifact.kind}:${artifact.title}`;
  const docs = await listDocuments(kb.db, kb.workspaceId);
  for (const doc of docs) {
    if (doc.source === source) await deleteDocument(kb.db, doc.id);
  }
  await kbIngest(kb, {
    title: `${artifact.title} (v${artifact.version})`,
    content: artifact.body.trim() || artifact.title,
    source,
  });
}

export function registerProjectTools(
  registry: BuiltinToolRegistry,
  deps: { db: Db; workspaceId: string; kb?: KbDeps },
): void {
  /** Workspace-scoping guard: a tool must never touch another workspace's
   *  project, whatever id an injected instruction supplies. */
  const requireProject = async (projectId: string) => {
    const project = await getProject(deps.db, projectId);
    if (!project || project.workspaceId !== deps.workspaceId) {
      throw new Error(`project "${projectId}" not found`);
    }
    return project;
  };

  registry.register(
    "project",
    "list",
    "List the Workshop projects in this workspace (id, name, mode, phase, status).",
    "read_auto",
    { type: "object", properties: {} },
    async () => {
      const rows = await listProjects(deps.db, deps.workspaceId);
      return rows.map((p) => ({ id: p.id, name: p.name, mode: p.mode, phase: p.phase, status: p.status }));
    },
  );

  registry.register(
    "project",
    "artifact.list",
    "List a project's artifacts (specs, plans, todos, learnings, ADRs), optionally filtered by kind/status.",
    "read_auto",
    {
      type: "object",
      properties: {
        projectId: { type: "string" },
        kind: { type: "string", description: "spec | plan | todo | learning | adr" },
        status: { type: "string" },
      },
      required: ["projectId"],
    },
    async (args) => {
      await requireProject(String(args.projectId ?? ""));
      const rows = await listArtifacts(deps.db, String(args.projectId), {
        kind: args.kind ? String(args.kind) : undefined,
        status: args.status ? String(args.status) : undefined,
      });
      return rows.map((a) => ({ id: a.id, kind: a.kind, status: a.status, title: a.title, version: a.version }));
    },
  );

  registry.register(
    "project",
    "artifact.read",
    "Read one project artifact in full (title, body, status, version, mission link).",
    "read_auto",
    { type: "object", properties: { artifactId: { type: "string" } }, required: ["artifactId"] },
    async (args) => {
      const row = await getArtifact(deps.db, String(args.artifactId ?? ""));
      if (!row) throw new Error("artifact not found");
      await requireProject(row.projectId);
      return row;
    },
  );

  registry.register(
    "project",
    "artifact.write",
    "Create a project artifact: a spec/plan (new version if the title exists), a todo (backlog|active), a learning (append-only), or an ADR (proposed). Lifecycle rules are enforced.",
    "write_approved",
    {
      type: "object",
      properties: {
        projectId: { type: "string" },
        kind: { type: "string", description: "spec | plan | todo | learning | adr" },
        title: { type: "string" },
        body: { type: "string" },
        status: { type: "string", description: "todos: backlog|active · ADRs: proposed|accepted" },
      },
      required: ["projectId", "kind", "title"],
    },
    async (args) => {
      await requireProject(String(args.projectId ?? ""));
      const row = await writeArtifact(deps.db, {
        projectId: String(args.projectId),
        kind: String(args.kind) as "spec" | "plan" | "todo" | "learning" | "adr",
        title: String(args.title),
        body: args.body === undefined ? undefined : String(args.body),
        status: args.status === undefined ? undefined : String(args.status),
      });
      if (deps.kb) {
        // Best-effort: a mirror failure must not lose the artifact write.
        await mirrorArtifactToKb(deps.kb, row).catch(() => {});
      }
      return { id: row.id, kind: row.kind, status: row.status, title: row.title, version: row.version };
    },
  );

  registry.register(
    "project",
    "todo.next",
    "The project's next undone task: oldest active todo, else oldest backlog todo.",
    "read_auto",
    { type: "object", properties: { projectId: { type: "string" } }, required: ["projectId"] },
    async (args) => {
      await requireProject(String(args.projectId ?? ""));
      const row = await nextTodo(deps.db, String(args.projectId));
      return row ? { id: row.id, title: row.title, status: row.status, body: row.body } : null;
    },
  );

  registry.register(
    "project",
    "todo.complete",
    "Complete a todo, recording the current mission as the completing mission (the audit-trail link is mandatory).",
    "write_approved",
    { type: "object", properties: { todoId: { type: "string" } }, required: ["todoId"] },
    async (args, ctx) => {
      const row = await getArtifact(deps.db, String(args.todoId ?? ""));
      if (!row) throw new Error("artifact not found");
      await requireProject(row.projectId);
      if (!ctx.missionId) {
        throw new Error("project.todo.complete requires a mission context — the completing mission is the audit link");
      }
      const updated = await completeTodo(deps.db, row.id, ctx.missionId);
      return { id: updated.id, status: updated.status, missionId: updated.missionId };
    },
  );
}
