import { z } from "zod";

/** Autonomy tiers — see docs/PRD.md §4. */
export const AutonomyTier = z.enum(["read_auto", "write_approved", "destructive_confirmed"]);
export type AutonomyTier = z.infer<typeof AutonomyTier>;

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
