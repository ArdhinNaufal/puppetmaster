import { z } from "zod";

/** Autonomy tiers — see docs/PRD.md §4. */
export const AutonomyTier = z.enum(["read_auto", "write_approved", "destructive_confirmed"]);
export type AutonomyTier = z.infer<typeof AutonomyTier>;

/** Workspace membership roles — see docs/PRD.md §MVP (owner / admin / builder / member). */
export const Role = z.enum(["owner", "admin", "builder", "member"]);
export type Role = z.infer<typeof Role>;

/** Ordering used by the RBAC gateway: a route guarded at `builder` admits builder and above. */
export const ROLE_RANK: Record<Role, number> = { member: 0, builder: 1, admin: 2, owner: 3 };

export const AgentDefinition = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  persona: z.string(),
  model: z.string(),
  autonomy: AutonomyTier.default("write_approved"),
  toolGrants: z.array(z.string()).default([]),
  schedule: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

export const WorkflowNodeKind = z.enum([
  "trigger",
  "action",
  "logic",
  "code",
  "agent",
  "approval",
  /** Deterministic gate (Workshop, ADR-002/WP4): runs a declared check; the
   *  exit code gates the edge. Schema lands in WP2; execution lands in WP4 —
   *  the linter flags verify nodes as not-yet-executable until then. */
  "verify",
]);
export type WorkflowNodeKind = z.infer<typeof WorkflowNodeKind>;

export const NodePosition = z.object({ x: z.number(), y: z.number() });
export type NodePosition = z.infer<typeof NodePosition>;

export const WorkflowNode = z.object({
  id: z.string(),
  kind: WorkflowNodeKind,
  label: z.string(),
  config: z.record(z.unknown()).default({}),
  position: NodePosition.default({ x: 0, y: 0 }),
  /** Per-node execution policy for the DAG executor (ARCHITECTURE.md §3.2). */
  retries: z.number().int().nonnegative().default(0),
  timeoutMs: z.number().int().positive().default(30_000),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowEdge = z.object({
  from: z.string(),
  to: z.string(),
  /** Optional JS boolean expression evaluated against the source node output (`out`). */
  condition: z.string().nullable().default(null),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

/** Per-node config shapes, validated by the executor's node handlers. */
export const TriggerConfig = z.object({
  mode: z.enum(["manual", "cron", "webhook"]).default("manual"),
  cron: z.string().optional(),
  path: z.string().optional(),
});
export type TriggerConfig = z.infer<typeof TriggerConfig>;

export const ActionConfig = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
});
export type ActionConfig = z.infer<typeof ActionConfig>;

export const LogicConfig = z.object({
  op: z.enum(["branch", "wait", "passthrough"]).default("passthrough"),
  expression: z.string().optional(),
  ms: z.number().int().nonnegative().optional(),
});
export type LogicConfig = z.infer<typeof LogicConfig>;

export const CodeConfig = z.object({
  source: z.string(),
  timeoutMs: z.number().int().positive().default(2_000),
});
export type CodeConfig = z.infer<typeof CodeConfig>;

export const ApprovalConfig = z.object({
  prompt: z.string().default("Approve this step?"),
  tier: AutonomyTier.default("write_approved"),
});
export type ApprovalConfig = z.infer<typeof ApprovalConfig>;

/** Agent node (the bridge, workflow → agent): send a task, await the result. */
export const AgentNodeConfig = z.object({
  agentId: z.string().min(1),
  /** Task template; `{{input}}` interpolates the upstream node output. */
  message: z.string().default("{{input}}"),
});
export type AgentNodeConfig = z.infer<typeof AgentNodeConfig>;

/** The full editable graph carried by a workflow version. */
export const WorkflowGraph = z.object({
  nodes: z.array(WorkflowNode),
  edges: z.array(WorkflowEdge),
});
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

export const WorkflowDefinition = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  version: z.number().int().positive().default(1),
  nodes: z.array(WorkflowNode),
  edges: z.array(WorkflowEdge),
  createdAt: z.coerce.date(),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export const MissionStatus = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
]);
export type MissionStatus = z.infer<typeof MissionStatus>;

export const Mission = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  kind: z.enum(["agent", "workflow"]),
  subjectId: z.string().uuid(),
  parentMissionId: z.string().uuid().nullable().default(null),
  status: MissionStatus,
  startedAt: z.coerce.date().nullable().default(null),
  finishedAt: z.coerce.date().nullable().default(null),
});
export type Mission = z.infer<typeof Mission>;

/** Per-node execution record — the source of the mission trace view. */
export const StepStatus = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "awaiting_approval",
]);
export type StepStatus = z.infer<typeof StepStatus>;

export const MissionStep = z.object({
  id: z.string().uuid(),
  missionId: z.string().uuid(),
  nodeId: z.string(),
  kind: WorkflowNodeKind,
  status: StepStatus,
  attempt: z.number().int().nonnegative().default(0),
  input: z.unknown().nullable().default(null),
  output: z.unknown().nullable().default(null),
  error: z.string().nullable().default(null),
  startedAt: z.coerce.date().nullable().default(null),
  finishedAt: z.coerce.date().nullable().default(null),
});
export type MissionStep = z.infer<typeof MissionStep>;

/* ————— The Workshop (docs/AI-SDLC-INTEGRATION-PLAN.md WP2; ADR-001/003/004) ————— */

export const ProjectMode = z.enum(["supervised", "gated"]);
export type ProjectMode = z.infer<typeof ProjectMode>;

export const ProjectPhase = z.enum(["idle", "specify", "plan", "execute", "verify", "record"]);
export type ProjectPhase = z.infer<typeof ProjectPhase>;

export const ProjectStatus = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** A Workshop project: a repo plus its spec/todos/learnings/ADR artifacts
 *  (ADR-003 — first-class entity; missions stay single runs and carry
 *  projectId when they execute a phase). */
export const Project = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  repoRef: z.string().default(""),
  mode: ProjectMode.default("supervised"),
  phase: ProjectPhase.default("idle"),
  status: ProjectStatus.default("active"),
  workbenchId: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
});
export type Project = z.infer<typeof Project>;

/** Artifact kinds (ADR-004). Evidence lives in its own step/approval-scoped
 *  table, not here — one home per concept. */
export const ArtifactKind = z.enum(["spec", "plan", "todo", "learning", "adr"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const TodoStatus = z.enum(["backlog", "active", "completed"]);
export type TodoStatus = z.infer<typeof TodoStatus>;

export const AdrStatus = z.enum(["proposed", "accepted", "superseded"]);
export type AdrStatus = z.infer<typeof AdrStatus>;

/** Lifecycle rules (enforced in the repo layer, not by convention):
 *  learnings are append-only; accepted ADRs are immutable (supersede only);
 *  todo completion requires the completing mission's id; spec/plan changes
 *  are new versions chained via supersedesId. */
export const ProjectArtifact = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  kind: ArtifactKind,
  /** TodoStatus for todos, AdrStatus for ADRs, null for the other kinds. */
  status: z.string().nullable().default(null),
  title: z.string().min(1),
  body: z.string().default(""),
  version: z.number().int().positive().default(1),
  supersedesId: z.string().uuid().nullable().default(null),
  missionId: z.string().uuid().nullable().default(null),
  createdAt: z.coerce.date(),
});
export type ProjectArtifact = z.infer<typeof ProjectArtifact>;

export const VerifyCheckName = z.enum(["test", "arch", "refactor-gate", "todo-sync", "spec-sections", "load", "custom"]);
export type VerifyCheckName = z.infer<typeof VerifyCheckName>;

/** A deterministic check a project's verify nodes run (WP4). Checks are
 *  earned policies: disabled by default, enabled per project with a note on
 *  what failure earned them. `baseline` is the legacy ratchet count. */
export const VerifyCheck = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: VerifyCheckName,
  command: z.string().nullable().default(null),
  baseline: z.number().int().nonnegative().nullable().default(null),
  enabled: z.boolean().default(false),
  earnedNote: z.string().default(""),
  createdAt: z.coerce.date(),
});
export type VerifyCheck = z.infer<typeof VerifyCheck>;

/** Endpoint kinds and semantic relations for project-scoped SDLC traceability.
 *  Links intentionally connect durable artifacts and deterministic checks only:
 *  conversations remain transient, while both endpoint kinds have stable ids. */
export const TraceRefType = z.enum(["artifact", "check"]);
export type TraceRefType = z.infer<typeof TraceRefType>;

export const TraceRelation = z.enum(["informs", "derives", "verifies", "mitigates"]);
export type TraceRelation = z.infer<typeof TraceRelation>;

export const ProjectTraceLink = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sourceType: TraceRefType,
  sourceId: z.string().uuid(),
  targetType: TraceRefType,
  targetId: z.string().uuid(),
  relation: TraceRelation,
  rationale: z.string().trim().min(1),
  createdAt: z.coerce.date(),
});
export type ProjectTraceLink = z.infer<typeof ProjectTraceLink>;

/** Config for the `verify` node kind (WP4): a deterministic gate. The check
 *  runs via the deployment's CheckRunner; on failure the executor loops the
 *  fix agent (if configured) up to `retriesBeforeEscalate` times with the
 *  check's failure output as instruction, then escalates to a human approval
 *  with evidence attached (the corpus's 8-block override, made policy).
 *  `projectId` / `fixAgentId` support `{{input.*}}` templating like action args. */
export const VerifyNodeConfig = z.object({
  projectId: z.string().min(1),
  check: VerifyCheckName,
  fixAgentId: z.string().optional(),
  retriesBeforeEscalate: z.number().int().min(1).max(20).default(8),
});
export type VerifyNodeConfig = z.infer<typeof VerifyNodeConfig>;

export const EvidenceKind = z.enum(["test-output", "diff", "screenshot", "state-assert"]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** Machine-checkable evidence attached to a verify step or an approval, so
 *  the gate's reviewer judges evidence instead of reconstructing trust
 *  (org layer §1). Written by WP4's verify handler. */
export const Evidence = z.object({
  id: z.string().uuid(),
  stepId: z.string().uuid().nullable().default(null),
  approvalId: z.string().uuid().nullable().default(null),
  kind: EvidenceKind,
  content: z.unknown().nullable().default(null),
  ref: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
});
export type Evidence = z.infer<typeof Evidence>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Approval = z.object({
  id: z.string().uuid(),
  missionId: z.string().uuid(),
  nodeId: z.string(),
  prompt: z.string(),
  tier: AutonomyTier,
  status: ApprovalStatus,
  createdAt: z.coerce.date(),
  decidedAt: z.coerce.date().nullable().default(null),
});
export type Approval = z.infer<typeof Approval>;
