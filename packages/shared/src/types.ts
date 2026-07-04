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

export const WorkflowNode = z.object({
  id: z.string(),
  kind: WorkflowNodeKind,
  label: z.string(),
  config: z.record(z.unknown()).default({}),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowEdge = z.object({
  from: z.string(),
  to: z.string(),
  condition: z.string().nullable().default(null),
});
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

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
