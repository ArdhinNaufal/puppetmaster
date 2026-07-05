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
  getWebhook: (id: string) =>
    fetch(`/api/workflows/${id}/webhook`).then(
      json<{ url: string; hasSecret: boolean; secret: string | null; header: string; scheme: string }>,
    ),
  rotateWebhook: (id: string) =>
    fetch(`/api/workflows/${id}/webhook/rotate`, { method: "POST" }).then(json<{ secret: string }>),
  listMissions: () => fetch("/api/missions").then(json<Mission[]>),
  getMission: (id: string) =>
    fetch(`/api/missions/${id}`).then(json<{ mission: Mission; steps: MissionStep[] }>),
  cancelMission: (id: string) =>
    fetch(`/api/missions/${id}/cancel`, { method: "POST" }).then(
      json<{ ok: boolean; cancelled: boolean; cancelling: boolean }>,
    ),
  retryMission: (id: string) =>
    fetch(`/api/missions/${id}/retry`, { method: "POST" }).then(json<{ ok: boolean }>),
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
  kind: string;
  pinned: boolean;
  importance: number;
  missionId: string | null;
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
  searchMemories: (id: string, q: string) =>
    fetch(`/api/agents/${id}/memory-search?q=${encodeURIComponent(q)}`).then(json<MemoryHit[]>),
  updateMemory: (id: string, memId: string, patch: { content?: string; pinned?: boolean }) =>
    fetch(`/api/agents/${id}/memories/${memId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<AgentMemory>),
  deleteMemory: (id: string, memId: string) =>
    fetch(`/api/agents/${id}/memories/${memId}`, { method: "DELETE" }),
};

/* ------------------------------------------------------ Templates & signals */

export interface Template {
  id: string;
  workspaceId: string | null;
  kind: "workflow" | "agent";
  name: string;
  description: string;
  category: string;
  builtin: boolean;
  createdAt: string;
}
/** A ranked memory recall result; `score` is null on the keyword fallback. */
export interface MemoryHit {
  id: string;
  content: string;
  score: number | null;
}
export interface Suggestion {
  subjectId: string;
  kind: string;
  name: string;
  runs: number;
  lastRun: string;
}

export const templateApi = {
  list: () => fetch("/api/templates").then(json<Template[]>),
  instantiate: (id: string, name?: string) =>
    post(`/api/templates/${id}/instantiate`, { name }).then(
      json<{ kind: "workflow" | "agent"; id: string }>,
    ),
  publish: (input: { kind: "workflow" | "agent"; sourceId: string; name?: string; description?: string; category?: string }) =>
    post("/api/templates", input).then(json<Template>),
  remove: (id: string) => fetch(`/api/templates/${id}`, { method: "DELETE" }),
};

export const suggestionApi = {
  get: () => fetch("/api/suggestions").then(json<Suggestion[]>),
};

export interface AuditEntry {
  id: string;
  actorKind: "user" | "agent" | "system";
  actorId: string | null;
  actorLabel: string | null;
  missionId: string | null;
  action: string;
  target: string | null;
  detail: unknown;
  createdAt: string;
}

export const auditApi = {
  list: (action?: string) =>
    fetch(`/api/audit${action ? `?action=${encodeURIComponent(action)}` : ""}`).then(json<AuditEntry[]>),
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
  status: () => fetch("/api/auth/status").then(json<{ needsSetup: boolean; oidcEnabled: boolean }>),
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

// --- Knowledge base (Stage 3) ---------------------------------------------------

export interface KbDocument {
  id: string;
  title: string;
  source: string;
  mime: string;
  chunkCount: number;
  createdAt: string;
}

export interface KbSearchHit {
  chunkId: string;
  documentId: string;
  title: string;
  idx: number;
  heading: string;
  content: string;
  score: number;
  citation: string;
}

export const kbApi = {
  list: () => fetch("/api/kb/documents").then(json<KbDocument[]>),
  upload: (input: { title: string; content: string; source?: string; mime?: string }) =>
    post("/api/kb/documents", input).then(
      json<{ document: KbDocument; chunkCount: number; embedded: number }>,
    ),
  get: (id: string) =>
    fetch(`/api/kb/documents/${id}`).then(
      json<{ document: KbDocument & { content: string }; chunks: { idx: number; heading: string; content: string }[] }>,
    ),
  remove: (id: string) => fetch(`/api/kb/documents/${id}`, { method: "DELETE" }),
  search: (q: string, limit = 5) =>
    fetch(`/api/kb/search?q=${encodeURIComponent(q)}&limit=${limit}`).then(json<KbSearchHit[]>),
};

export type BusEvent =
  | { type: "mission.started"; missionId: string; agentId?: string; at: string }
  | { type: "agent.message"; agentId: string; missionId: string; role: string; text: string; at: string }
  | { type: "mission.finished"; missionId: string; status: string; at: string }
  | { type: "mission.step"; missionId: string; nodeId: string; kind: NodeKind; status: StepStatus; at: string }
  | { type: "approval.requested"; missionId: string; nodeId: string; approvalId: string; prompt: string; at: string }
  | { type: "approval.resolved"; missionId: string; approvalId: string; approved: boolean; at: string };
