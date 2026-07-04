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
  kind: string;
  parentMissionId: string | null;
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

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? res.statusText);
  }
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

export interface Agent {
  id: string;
  name: string;
  persona: string;
  model: string;
  autonomy: string;
  schedule: string | null;
  scratchpad: Record<string, unknown>;
  createdAt: string;
}
export interface AgentMessage {
  id: string;
  agentId: string;
  missionId: string | null;
  role: "user" | "assistant" | "tool";
  content: {
    text?: string;
    toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
    toolResults?: { toolCallId: string; result: unknown; isError?: boolean }[];
  };
  createdAt: string;
}
export interface AgentMemory {
  id: string;
  content: string;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  branding: { brandName?: string; accent?: string };
}

export const workspaceApi = {
  get: () => fetch("/api/workspace").then(json<Workspace>),
  update: (patch: { name?: string; branding?: Workspace["branding"] }) =>
    fetch("/api/workspace", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<Workspace>),
};

export const agentApi = {
  list: () => fetch("/api/agents").then(json<Agent[]>),
  create: (input: { name: string; persona?: string; model?: string; autonomy?: string }) =>
    fetch("/api/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }).then(json<Agent>),
  remove: (id: string) => fetch(`/api/agents/${id}`, { method: "DELETE" }),
  chat: (id: string, message: string) =>
    fetch(`/api/agents/${id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }).then(json<{ missionId: string }>),
  messages: (id: string) => fetch(`/api/agents/${id}/messages`).then(json<AgentMessage[]>),
  memories: (id: string) => fetch(`/api/agents/${id}/memories`).then(json<AgentMemory[]>),
};

/* ------------------------------------------------------------ Auth / members */

export type Role = "owner" | "admin" | "builder" | "member";

export interface Me {
  user: { id: string; email: string; name: string };
  role: Role;
  workspaceId: string;
}
export interface MemberRow {
  userId: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}

/** Per-user layout persisted in ui_preferences (ARCHITECTURE.md §4). */
export interface PanelLayout {
  order?: string[];
  collapsed?: Record<string, boolean>;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const authApi = {
  status: () => fetch("/api/auth/status").then(json<{ needsSetup: boolean }>),
  setup: (input: { email: string; name: string; password: string }) =>
    post("/api/auth/setup", input).then(json<{ user: Me["user"]; role: Role }>),
  login: (email: string, password: string) =>
    post("/api/auth/login", { email, password }).then(json<{ user: Me["user"]; role: Role }>),
  logout: () => post("/api/auth/logout", {}).then(() => undefined).catch(() => undefined),
  me: () => fetch("/api/auth/me").then(json<Me>),
};

export const memberApi = {
  list: () => fetch("/api/members").then(json<MemberRow[]>),
  create: (input: { email: string; name: string; password: string; role: Role }) =>
    post("/api/members", input).then(json<MemberRow>),
  setRole: (userId: string, role: Role) =>
    fetch(`/api/members/${userId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }).then(json<{ userId: string; role: Role }>),
  remove: (userId: string) => fetch(`/api/members/${userId}`, { method: "DELETE" }),
};

export const prefsApi = {
  get: () => fetch("/api/me/preferences").then(json<{ layout: { panels?: PanelLayout } }>),
  save: (layout: { panels?: PanelLayout }) =>
    fetch("/api/me/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout }),
    }).then(json<{ layout: { panels?: PanelLayout } }>),
};

export type BusEvent =
  | { type: "mission.started"; missionId: string; agentId?: string; at: string }
  | { type: "agent.message"; agentId: string; missionId: string; role: string; text: string; at: string }
  | { type: "mission.finished"; missionId: string; status: string; at: string }
  | { type: "mission.step"; missionId: string; nodeId: string; kind: NodeKind; status: StepStatus; at: string }
  | { type: "approval.requested"; missionId: string; nodeId: string; approvalId: string; prompt: string; at: string }
  | { type: "approval.resolved"; missionId: string; approvalId: string; approved: boolean; at: string };
