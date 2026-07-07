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
export interface ApprovalEvidence {
  id: string;
  kind: string;
  content: unknown;
  ref: string | null;
}
export interface Approval {
  id: string;
  missionId: string;
  nodeId: string;
  prompt: string;
  tier: string;
  status: string;
  createdAt: string;
  /** Workshop WP4: verify-gate escalations carry their check runs — the
   *  inbox judges evidence, not assertions (org layer §1). */
  evidence?: ApprovalEvidence[];
}

export interface LintIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  nodeId?: string;
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
  explainMission: (id: string) =>
    fetch(`/api/missions/${id}/explain`, { method: "POST" }).then(
      json<{ summary: string; diagnosis: string; failedNodeId: string | null }>,
    ),
  draftWorkflow: (description: string) =>
    post("/api/workflows/draft", { description }).then(
      json<{ graph: WorkflowGraph; source: string; model: string; issues: LintIssue[] }>,
    ),
  lintWorkflow: (graph: WorkflowGraph) =>
    post("/api/workflows/lint", { graph }).then(json<LintIssue[]>),
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
  /** Stage 9C: compact large tool results before they enter this agent's context. */
  contextCompaction: boolean;
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

/** NEXUS pane arrangement (docs/NEXUS.md §4.4). */
export interface NexusLayout {
  panes?: { task: string; x: number; y: number; ctx?: Record<string, unknown>; z?: number }[];
}

/** PROCESS WATCH strip state (docs/PROCESS-WATCH.md). */
export interface WatchLayout {
  open?: boolean;
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
  get: () => fetch("/api/me/preferences").then(json<{ layout: { panels?: PanelLayout; nexus?: NexusLayout; watch?: WatchLayout } }>),
  /** Merges the given keys over the saved layout (server stores the whole object). */
  save: async (layout: { panels?: PanelLayout; nexus?: NexusLayout; watch?: WatchLayout }) => {
    const current = await fetch("/api/me/preferences")
      .then(json<{ layout: Record<string, unknown> }>)
      .catch(() => ({ layout: {} as Record<string, unknown> }));
    return fetch("/api/me/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout: { ...current.layout, ...layout } }),
    }).then(json<{ layout: { panels?: PanelLayout; nexus?: NexusLayout; watch?: WatchLayout } }>);
  },
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


// --- The Workshop (AI-SDLC plan WP7a) ----------------------------------------------
export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  repoRef: string;
  mode: "supervised" | "gated";
  phase: "idle" | "specify" | "plan" | "execute" | "verify" | "record";
  status: "active" | "archived";
  workbenchId: string | null;
  createdAt: string;
}
export interface ProjectArtifact {
  id: string;
  projectId: string;
  kind: "spec" | "plan" | "todo" | "learning" | "adr";
  status: string | null;
  title: string;
  body: string;
  version: number;
  supersedesId: string | null;
  missionId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface VerifyCheckRow {
  id: string;
  projectId: string;
  name: string;
  command: string | null;
  baseline: number | null;
  enabled: boolean;
  earnedNote: string;
  createdAt: string;
}

export const projectApi = {
  list: () => fetch("/api/projects").then(json<Project[]>),
  create: (input: { name: string; repoRef?: string; mode?: string }) =>
    post("/api/projects", input).then(json<Project>),
  get: (id: string) => fetch(`/api/projects/${id}`).then(json<Project>),
  update: (id: string, patch: { phase?: string; status?: string; mode?: string }) =>
    fetch(`/api/projects/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<Project>),
  artifacts: (id: string, filter?: { kind?: string; status?: string }) => {
    const q = new URLSearchParams();
    if (filter?.kind) q.set("kind", filter.kind);
    if (filter?.status) q.set("status", filter.status);
    const qs = q.toString();
    return fetch(`/api/projects/${id}/artifacts${qs ? `?${qs}` : ""}`).then(json<ProjectArtifact[]>);
  },
  writeArtifact: (id: string, input: { kind: string; title: string; body?: string; status?: string }) =>
    post(`/api/projects/${id}/artifacts`, input).then(json<ProjectArtifact>),
  checks: (id: string) => fetch(`/api/projects/${id}/checks`).then(json<VerifyCheckRow[]>),
  createCheck: (id: string, input: { name: string; command?: string; enabled?: boolean; earnedNote?: string }) =>
    post(`/api/projects/${id}/checks`, input).then(json<VerifyCheckRow>),
  updateCheck: (id: string, checkId: string, patch: { enabled?: boolean; earnedNote?: string; command?: string }) =>
    fetch(`/api/projects/${id}/checks/${checkId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<VerifyCheckRow>),
};

// --- Evals & observability (Stage 5) ----------------------------------------------

export interface EvalRun {
  id: string;
  suite: string;
  k: number;
  passed: number;
  total: number;
  results: { id: string; description: string; passes: boolean[]; pass: boolean; trajectoryOk: boolean; notes: string[] }[];
  createdAt: string;
}

export interface UsageBreakdownRow {
  agentId: string | null;
  agentName: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface Budget {
  id: string;
  agentId: string | null;
  monthlyTokenLimit: number;
  createdAt: string;
}

// --- Router profiles (Stage 9A) -----------------------------------------------

export type CostClass = "premium" | "cheap" | "local" | "free";

export interface RouterProfile {
  id: string;
  name: string;
  description: string;
  candidates: { model: string; costClass: CostClass }[];
  minClassForGatedTools: CostClass | null;
  enabled: boolean;
  createdAt: string;
}

export const routerApi = {
  list: () =>
    fetch("/api/router/profiles").then(
      json<{ costClasses: CostClass[]; profiles: RouterProfile[] }>,
    ),
  create: (input: {
    name: string;
    description?: string;
    candidates: { model: string; costClass: CostClass }[];
    minClassForGatedTools?: CostClass | null;
  }) => post("/api/router/profiles", input).then(json<RouterProfile>),
  setEnabled: (id: string, enabled: boolean) =>
    fetch(`/api/router/profiles/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    }).then(json<RouterProfile>),
  remove: (id: string) => fetch(`/api/router/profiles/${id}`, { method: "DELETE" }),
};

/** Candidate health from the model router (Stage 9B). */
export interface RouterCandidateHealth {
  state: "healthy" | "cooling";
  consecutiveFailures: number;
  cooldownUntil: string | null;
  lastError: string | null;
}

export interface UsageReport {
  monthTokens: number;
  breakdown: UsageBreakdownRow[];
  routerFailures: Record<string, number>;
  routerHealth: Record<string, RouterCandidateHealth>;
  /** Stage 9C context-compaction savings since boot. */
  compaction: { applications: number; rawBytes: number; sentBytes: number; tokensAvoided: number };
}

export const opsApi = {
  listEvals: () => fetch("/api/evals").then(json<EvalRun[]>),
  runEvals: (k = 3) => post("/api/evals/run", { k }).then(json<EvalRun>),
  usage: () => fetch("/api/usage").then(json<UsageReport>),
  listBudgets: () => fetch("/api/budgets").then(json<Budget[]>),
  createBudget: (input: { agentId?: string | null; monthlyTokenLimit: number }) =>
    post("/api/budgets", input).then(json<Budget>),
  deleteBudget: (id: string) => fetch(`/api/budgets/${id}`, { method: "DELETE" }),
};

// --- MCP servers & registry (Stage 7) ----------------------------------------------

export interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  tier: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  createdAt: string;
}

export interface McpRegistryEntry {
  name: string;
  description: string;
  version: string;
  remoteUrl: string | null;
  remoteType: string | null;
}

export const mcpApi = {
  list: () => fetch("/api/mcp/servers").then(json<McpServerRow[]>),
  add: (input: {
    name: string;
    transport?: string;
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
    tier?: string;
  }) => post("/api/mcp/servers", input).then(json<{ id: string; connected: boolean; toolCount?: number; error?: string }>),
  remove: (id: string) => fetch(`/api/mcp/servers/${id}`, { method: "DELETE" }),
  registry: (q: string) =>
    fetch(`/api/mcp/registry?q=${encodeURIComponent(q)}`).then(json<{ servers: McpRegistryEntry[] }>),
};

/** Kernel resource sample (docs/PROCESS-WATCH.md R-VITALS). */
export interface OpsVitals {
  type: "ops.vitals";
  at: string;
  cpuPct: number;
  rssMb: number;
  heapMb: number;
  loopLagMs: number;
  upSec: number;
  wsClients: number;
  running: number;
  gated: number;
  queued: number;
}

/** Safe llm.call/tool.call summary for the live process log. */
export interface AuditAppended {
  type: "audit.appended";
  at: string;
  action: string;
  actorKind: "user" | "agent" | "system";
  actorLabel: string | null;
  target: string | null;
  missionId: string | null;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  tier?: string;
}

export type BusEvent =
  | { type: "mission.started"; missionId: string; agentId?: string; at: string }
  | { type: "agent.message"; agentId: string; missionId: string; role: string; text: string; at: string }
  | { type: "mission.finished"; missionId: string; status: string; at: string }
  | { type: "mission.step"; missionId: string; nodeId: string; kind: NodeKind; status: StepStatus; at: string }
  | { type: "approval.requested"; missionId: string; nodeId: string; approvalId: string; prompt: string; at: string }
  | { type: "approval.resolved"; missionId: string; approvalId: string; approved: boolean; at: string }
  | { type: "agent.message.delta"; agentId: string; missionId: string; delta: string; at: string }
  | OpsVitals
  | AuditAppended;

export const watchApi = {
  vitals: () => fetch("/api/ops/vitals").then(json<{ samples: OpsVitals[] }>),
};
