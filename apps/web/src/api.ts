/** Thin typed client for the Puppetmaster server REST API. */

export type NodeKind = "trigger" | "action" | "logic" | "code" | "agent" | "approval";
export type StepStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "awaiting_approval";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  retries?: number;
  timeoutMs?: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  condition?: string | null;
}
export interface WorkflowGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  currentVersion: number;
  createdAt: string;
}
export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  graph: WorkflowGraph;
}
export interface Mission {
  id: string;
  status: string;
  output: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface MissionStep {
  id: string;
  nodeId: string;
  kind: NodeKind;
  status: StepStatus;
  attempt: number;
  output: unknown;
  error: string | null;
}
export interface Approval {
  id: string;
  missionId: string;
  nodeId: string;
  prompt: string;
  tier: string;
  status: string;
  createdAt: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  bootstrap: () => fetch("/api/bootstrap").then(json<{ workspaceId: string; dbDriver: string; queue: string }>),
  tools: () => fetch("/api/tools").then(json<{ server: string; tool: string }[]>),
  listWorkflows: () => fetch("/api/workflows").then(json<Workflow[]>),
  getWorkflow: (id: string) =>
    fetch(`/api/workflows/${id}`).then(json<{ workflow: Workflow; version: WorkflowVersion }>),
  createWorkflow: (name: string, graph: WorkflowGraph) =>
    fetch("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, graph }),
    }).then(json<{ workflow: Workflow; version: WorkflowVersion }>),
  saveWorkflow: (id: string, graph: WorkflowGraph) =>
    fetch(`/api/workflows/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graph }),
    }).then(json<WorkflowVersion>),
  runWorkflow: (id: string, input: unknown) =>
    fetch(`/api/workflows/${id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }).then(json<{ missionId: string }>),
  listMissions: () => fetch("/api/missions").then(json<Mission[]>),
  getMission: (id: string) =>
    fetch(`/api/missions/${id}`).then(json<{ mission: Mission; steps: MissionStep[] }>),
  listApprovals: (status = "pending") =>
    fetch(`/api/approvals?status=${status}`).then(json<Approval[]>),
  resolveApproval: (id: string, approved: boolean) =>
    fetch(`/api/approvals/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved }),
    }).then(json<{ ok: boolean }>),
};

export type BusEvent =
  | { type: "mission.started"; missionId: string; at: string }
  | { type: "mission.finished"; missionId: string; status: string; at: string }
  | { type: "mission.step"; missionId: string; nodeId: string; kind: NodeKind; status: StepStatus; at: string }
  | { type: "approval.requested"; missionId: string; nodeId: string; approvalId: string; prompt: string; at: string }
  | { type: "approval.resolved"; missionId: string; approvalId: string; approved: boolean; at: string };
