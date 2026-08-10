/** Thin typed client for the Puppetmaster server REST API. */

import type { ClaudeEvent, ClaudeRun, ClaudeSession } from "@puppetmaster/shared";

export type NodeKind = "trigger" | "action" | "logic" | "code" | "agent" | "approval" | "verify";
export type MissionStepKind = NodeKind | "science";

/** Verify-check names (mirror of shared VerifyCheckName) — the verify-node
 *  config inspector's check picker (WP7.4). */
export const VERIFY_CHECK_NAMES = [
  "test",
  "arch",
  "refactor-gate",
  "todo-sync",
  "spec-sections",
  "load",
  "custom",
] as const;
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
  kind: MissionStepKind;
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
  constructor(
    public status: number,
    message: string,
    /** Parsed error payload, retained so callers can recover durable IDs. */
    public body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? res.statusText, body);
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

/** NEXUS pane arrangement (docs/NEXUS.md §4.4). Panes dock to a flank;
 *  `x`/`y` survive only to migrate pre-dock layouts on restore. */
export interface NexusLayout {
  panes?: { task: string; side?: "left" | "right"; x?: number; y?: number; ctx?: Record<string, unknown>; z?: number }[];
  /** Per-user mission result acknowledgement tags used by NEXUS's pane gate. */
  acknowledgedResults?: Record<string, { status: string; acknowledgedAt: string }>;
}

/** PROCESS WATCH strip state (docs/PROCESS-WATCH.md). */
export interface WatchLayout {
  open?: boolean;
}

/** Science Operations workspace state. Selection is convenience state only;
 * authoritative study/run data is always reloaded from REST. */
export interface ScienceLayout {
  studyId?: string;
  runId?: string;
  railCollapsed?: boolean;
  dossierCollapsed?: boolean;
  fallbackMode?: "auto" | "static" | "table";
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
  get: () => fetch("/api/me/preferences").then(json<{ layout: { panels?: PanelLayout; nexus?: NexusLayout; watch?: WatchLayout; science?: ScienceLayout } }>),
  /** Merges the given keys over the saved layout (server stores the whole object). */
  save: async (layout: { panels?: PanelLayout; nexus?: NexusLayout; watch?: WatchLayout; science?: ScienceLayout }) => {
    const current = await fetch("/api/me/preferences")
      .then(json<{ layout: Record<string, unknown> }>)
      .catch(() => ({ layout: {} as Record<string, unknown> }));
    return fetch("/api/me/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ layout: { ...current.layout, ...layout } }),
    }).then(json<{ layout: { panels?: PanelLayout; nexus?: NexusLayout; watch?: WatchLayout; science?: ScienceLayout } }>);
  },
};

// --- Science Operations --------------------------------------------------------

export interface SciencePage<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface ScienceWorkspaceAdmission {
  workspaceId: string;
  admitted: boolean;
  updatedAt: string | null;
}

export type ScienceRunState =
  | "draft"
  | "awaiting_approval"
  | "queued"
  | "provisioning"
  | "running"
  | "finalizing"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ScienceStudy {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: "active" | "archived" | string;
  classification: string;
  workshopProjectId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceArtifactVersion {
  id: string;
  artifactId: string;
  version: number;
  status: "pending" | "ready" | "quarantined" | "expired" | string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  metadata: Record<string, unknown>;
  parentVersionId: string | null;
  createdBy?: string;
  createdAt: string;
  readyAt?: string | null;
}

export interface ScienceArtifact {
  id: string;
  studyId: string;
  logicalName: string;
  kind: string;
  format: string;
  status: string;
  createdBy?: string;
  versionCount?: number;
  /** List/detail projection required by the Science rail; content is not included. */
  latestVersion?: ScienceArtifactVersion | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScienceResourceRequest {
  cpuMillicores: number;
  memoryMb: number;
  gpuCount: number;
  wallTimeSeconds: number;
}

export type ScienceComputeProviderKind =
  | "local_container"
  | "jupyter_enterprise_gateway";

export interface ScienceComputeSnapshot {
  profileId: string;
  providerKind: ScienceComputeProviderKind;
  imageDigest: string;
  kernelName: string;
  resourceBounds: ScienceResourceRequest;
  config: Record<string, unknown>;
}

export interface ScienceComputeProfile {
  id: string;
  workspaceId: string;
  name: string;
  providerKind: ScienceComputeProviderKind;
  imageDigest: string;
  kernelName: string;
  resourceBounds: ScienceResourceRequest;
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** Optional measured quote projection; absent values are rendered as N/A. */
  availability?: "available" | "degraded" | "offline" | string;
  measuredEstimate?: {
    queueWaitMs?: number | null;
    cost?: number | null;
    currency?: string | null;
  } | null;
}

export type ScienceComputeProfileInput = Omit<
  ScienceComputeProfile,
  "id" | "workspaceId" | "createdAt" | "updatedAt" | "availability" | "measuredEstimate"
>;

export interface ScienceRunArtifactRef {
  id?: string;
  runId?: string;
  artifactVersionId: string;
  artifactId?: string;
  logicalName?: string;
  direction: "input" | "output";
  semanticRole: string;
  sha256?: string | null;
  sizeBytes?: number | null;
  createdAt?: string;
}

export interface ScienceRunEvent {
  id: string;
  runId: string;
  sequence: number;
  eventType: string;
  executionGeneration: number;
  state: ScienceRunState;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ScienceRun {
  id: string;
  studyId: string;
  missionId: string;
  computeProfileId: string;
  profileSnapshot: ScienceComputeSnapshot;
  profileName?: string;
  state: ScienceRunState;
  executionGeneration: number;
  idempotencyKey: string;
  parameters: Record<string, unknown>;
  resourceRequest: ScienceResourceRequest;
  progress?: number | null;
  manifest?: ScienceManifest | null;
  manifestHash: string | null;
  inputs?: ScienceRunArtifactRef[];
  outputs?: ScienceRunArtifactRef[];
  recentEvents?: ScienceRunEvent[];
  createdAt: string;
  updatedAt: string;
  submittedAt?: string | null;
  queuedAt?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface ScienceManifestArtifact {
  artifactVersionId: string;
  logicalName?: string;
  semanticRole: string;
  sha256: string;
  sizeBytes: number;
}

export interface ScienceManifest {
  schemaVersion: 1;
  studyId: string;
  runId: string;
  missionId: string;
  complete: boolean;
  gaps: string[];
  inputs: ScienceManifestArtifact[];
  outputs: ScienceManifestArtifact[];
  codeArtifactVersionId: string | null;
  sourceRevision: string | null;
  compute: ScienceComputeSnapshot & {
    requestedResources: ScienceResourceRequest;
    adapterVersion: string;
    dependencyLock: Record<string, unknown>;
  };
  parameters: Record<string, unknown>;
  units: Record<string, string>;
  randomSeeds: Record<string, number>;
  environment: Record<string, string>;
  actorId: string;
  approvalIds: string[];
  policyIds: string[];
  toolCalls: string[];
  startedAt: string | null;
  finishedAt: string;
  history: Array<{
    event: string;
    at: string;
    generation: number;
    detail: Record<string, unknown>;
  }>;
  validations: Record<string, unknown>[];
  limitations: string[];
}

export interface ScienceRunComparison {
  leftRunId: string;
  rightRunId: string;
  comparison: {
    sameInputs: boolean;
    sameParameters: boolean;
    sameEnvironment: boolean;
    sameOutputs: boolean;
    differences: string[];
    /** Null means no candidate validation declared both a metric and tolerance. */
    numericallyEquivalent: boolean | null;
    numericalValidation: {
      passed: boolean;
      metric: string | null;
      tolerance: number | string | Record<string, number | string> | null;
      observed: number | string | null;
      units: string | null;
    } | null;
  };
}

export interface ScienceRenderSession {
  id: string;
  workspaceId: string;
  runId: string | null;
  artifactVersionId: string | null;
  state: "starting" | "ready" | "expired" | "failed" | "revoked" | string;
  /** Authorized same-origin projection; never persisted in the session row. */
  url: string | null;
  expiresAt: string;
  heartbeatAt: string | null;
}

export interface ScienceRunInput {
  computeProfileId: string;
  inputs: Array<{
    artifactVersionId: string;
    semanticRole: string;
  }>;
  parameters: Record<string, unknown>;
  requestedResources: ScienceResourceRequest;
  idempotencyKey: string;
}

interface SciencePageEnvelope<T> {
  items?: T[];
  data?: T[];
  nextCursor?: string | null;
  next?: string | null;
  nextOffset?: number | null;
  total?: number;
}

/** Lists are cursor-bounded from v1. Accept an array only as a temporary
 * compatibility envelope; callers still render and retain one page at a time. */
async function sciencePage<T>(res: Response): Promise<SciencePage<T>> {
  const body = await json<T[] | SciencePageEnvelope<T>>(res);
  if (Array.isArray(body)) return { items: body, nextCursor: null, total: body.length };
  return {
    items: body.items ?? body.data ?? [],
    nextCursor: body.nextCursor ?? body.next ?? (body.nextOffset == null ? null : String(body.nextOffset)),
    ...(body.total === undefined ? {} : { total: body.total }),
  };
}

const scienceQuery = (input: { cursor?: string | null; limit?: number; state?: string } = {}) => {
  const query = new URLSearchParams();
  if (input.cursor) {
    if (/^\d+$/.test(input.cursor)) query.set("offset", input.cursor);
    else query.set("cursor", input.cursor);
  }
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.state) query.set("state", input.state);
  const qs = query.toString();
  return qs ? `?${qs}` : "";
};

async function expectScienceOk(res: Response): Promise<void> {
  if (res.ok) return;
  await json<never>(res);
}

async function scienceEntity<T>(res: Response, key: string): Promise<T> {
  const body = await json<T | Record<string, unknown>>(res);
  if (body && typeof body === "object" && key in body) {
    return (body as Record<string, unknown>)[key] as T;
  }
  return body as T;
}

async function scienceManifest(res: Response): Promise<ScienceManifest> {
  const body = await json<
    ScienceManifest | { manifest: ScienceManifest | null; manifestHash?: string | null }
  >(res);
  if ("manifest" in body) {
    if (body.manifest) return body.manifest;
    throw new ApiError(404, "No provenance manifest is available for this run.", body);
  }
  return body;
}

async function scienceRenderSession(res: Response): Promise<ScienceRenderSession> {
  const body = await json<
    | ScienceRenderSession
    | {
        session: Omit<ScienceRenderSession, "url"> & { url?: string | null };
        renderUrl?: string | null;
        launchUrl?: string | null;
      }
  >(res);
  if ("session" in body) {
    return {
      ...body.session,
      url: body.renderUrl ?? body.launchUrl ?? body.session.url ?? null,
    };
  }
  return body;
}

export const scienceApi = {
  workspaceAdmission: () =>
    fetch("/api/science/workspace-admission")
      .then(json<{ admission: ScienceWorkspaceAdmission }>)
      .then(({ admission }) => admission),
  updateWorkspaceAdmission: (input: { admitted: boolean; reason: string }) =>
    fetch("/api/science/workspace-admission", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    })
      .then(json<{ admission: ScienceWorkspaceAdmission }>)
      .then(({ admission }) => admission),
  studies: (input: { cursor?: string | null; limit?: number } = {}) =>
    fetch(`/api/science/studies${scienceQuery(input)}`).then(sciencePage<ScienceStudy>),
  createStudy: (input: { name: string; classification?: string; workshopProjectId?: string }) =>
    post("/api/science/studies", input).then((res) => scienceEntity<ScienceStudy>(res, "study")),
  study: (studyId: string) =>
    fetch(`/api/science/studies/${encodeURIComponent(studyId)}`).then(
      (res) => scienceEntity<ScienceStudy>(res, "study"),
    ),
  updateStudy: (studyId: string, patch: { name?: string; status?: string; classification?: string; workshopProjectId?: string | null }) =>
    fetch(`/api/science/studies/${encodeURIComponent(studyId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((res) => scienceEntity<ScienceStudy>(res, "study")),
  artifacts: (studyId: string, input: { cursor?: string | null; limit?: number } = {}) =>
    fetch(`/api/science/studies/${encodeURIComponent(studyId)}/artifacts${scienceQuery(input)}`).then(
      sciencePage<ScienceArtifact>,
    ),
  createArtifact: (studyId: string, input: { logicalName: string; kind: string; format: string }) =>
    post(`/api/science/studies/${encodeURIComponent(studyId)}/artifacts`, input).then(
      (res) => scienceEntity<ScienceArtifact>(res, "artifact"),
    ),
  artifactVersions: (
    artifactId: string,
    input: { cursor?: string | null; limit?: number } = {},
  ) =>
    fetch(
      `/api/science/artifacts/${encodeURIComponent(artifactId)}/versions${scienceQuery(input)}`,
    ).then(sciencePage<ScienceArtifactVersion>),
  beginUpload: (
    artifactId: string,
    input: {
      filename: string;
      expectedSizeBytes: number;
      expectedSha256: string;
      mediaType: string;
    },
  ) =>
    post(`/api/science/artifacts/${encodeURIComponent(artifactId)}/uploads`, input).then(
      json<{ uploadToken: string; uploadUrl?: string; expiresAt?: string }>,
    ),
  putUpload: async (uploadToken: string, file: Blob, uploadUrl?: string) => {
    const res = await fetch(uploadUrl ?? `/api/science/uploads/${encodeURIComponent(uploadToken)}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
    await expectScienceOk(res);
  },
  completeUpload: (
    uploadToken: string,
    input: {
      mediaType: string;
      metadata: Record<string, unknown> & { filename: string };
      parentVersionId?: string | null;
    },
  ) =>
    post(`/api/science/uploads/${encodeURIComponent(uploadToken)}/complete`, input).then(
      json<ScienceArtifactVersion>,
    ),
  artifactVersion: (versionId: string) =>
    fetch(`/api/science/artifact-versions/${encodeURIComponent(versionId)}`).then(
      (res) => scienceEntity<ScienceArtifactVersion>(res, "artifactVersion"),
    ),
  artifactContentUrl: (versionId: string) =>
    `/api/science/artifact-versions/${encodeURIComponent(versionId)}/content`,
  expireArtifactVersion: (versionId: string, confirmSha256: string) =>
    fetch(`/api/science/artifact-versions/${encodeURIComponent(versionId)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmSha256 }),
    }).then((res) =>
      scienceEntity<ScienceArtifactVersion>(res, "artifactVersion"),
    ),
  computeProfiles: () =>
    fetch("/api/science/compute-profiles")
      .then(sciencePage<ScienceComputeProfile>)
      .then((page) => page.items),
  createComputeProfile: (input: ScienceComputeProfileInput) =>
    post("/api/science/compute-profiles", input).then(
      (res) => scienceEntity<ScienceComputeProfile>(res, "profile"),
    ),
  updateComputeProfile: (
    profileId: string,
    patch: Partial<ScienceComputeProfileInput>,
  ) =>
    fetch(`/api/science/compute-profiles/${encodeURIComponent(profileId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((res) => scienceEntity<ScienceComputeProfile>(res, "profile")),
  runs: (studyId: string, input: { cursor?: string | null; limit?: number; state?: string } = {}) =>
    fetch(`/api/science/studies/${encodeURIComponent(studyId)}/runs${scienceQuery(input)}`).then(
      sciencePage<ScienceRun>,
    ),
  createRun: (studyId: string, input: ScienceRunInput) =>
    post(`/api/science/studies/${encodeURIComponent(studyId)}/runs`, {
      computeProfileId: input.computeProfileId,
      inputs: input.inputs,
      parameters: input.parameters,
      resourceRequest: input.requestedResources,
      idempotencyKey: input.idempotencyKey,
    }).then((res) => scienceEntity<ScienceRun>(res, "run")),
  run: (runId: string) =>
    fetch(`/api/science/runs/${encodeURIComponent(runId)}`).then(
      (res) => scienceEntity<ScienceRun>(res, "run"),
    ),
  cancelRun: (runId: string, input: { generation: number; reason?: string }) =>
    post(`/api/science/runs/${encodeURIComponent(runId)}/cancel`, input).then(
      (res) => scienceEntity<ScienceRun>(res, "run"),
    ),
  manifest: (runId: string) =>
    fetch(`/api/science/runs/${encodeURIComponent(runId)}/manifest`).then(scienceManifest),
  reproduce: (runId: string, input: { idempotencyKey: string }) =>
    post(`/api/science/runs/${encodeURIComponent(runId)}/reproduce`, input).then(
      (res) => scienceEntity<ScienceRun>(res, "run"),
    ),
  compareRuns: (runId: string, candidateRunId: string) =>
    post(`/api/science/runs/${encodeURIComponent(runId)}/reproduce`, {
      candidateRunId,
    }).then(json<ScienceRunComparison>),
  createRenderSession: (runId: string, input: { artifactVersionId?: string } = {}) =>
    post(`/api/science/runs/${encodeURIComponent(runId)}/render-sessions`, {
      ...input,
      audience: globalThis.location?.origin ?? "puppetmaster-web",
    }).then(scienceRenderSession),
  renewRenderSession: (sessionId: string) =>
    post(`/api/science/render-sessions/${encodeURIComponent(sessionId)}/renew`, {}).then(
      scienceRenderSession,
    ),
  closeRenderSession: async (sessionId: string) => {
    const res = await fetch(`/api/science/render-sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    await expectScienceOk(res);
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

export interface ToolRow {
  server: string;
  tool: string;
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

export interface SpecCoverage {
  /** The spec version the meter reflects, or null if no spec exists yet. */
  spec: { id: string; title: string; version: number } | null;
  required: string[];
  present: string[];
  thin: string[];
  missing: string[];
}

export type TraceRefType = "artifact" | "check";
export type TraceRelation = "informs" | "derives" | "verifies" | "mitigates";

/** A human-confirmed edge in the Workshop's decision graph. Links are
 * directional and keep their rationale so provenance survives hand-offs. */
export interface ProjectTraceLink {
  id: string;
  projectId: string;
  sourceType: TraceRefType;
  sourceId: string;
  targetType: TraceRefType;
  targetId: string;
  relation: TraceRelation;
  rationale: string;
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
  specCoverage: (id: string) => fetch(`/api/projects/${id}/spec-coverage`).then(json<SpecCoverage>),
  checks: (id: string) => fetch(`/api/projects/${id}/checks`).then(json<VerifyCheckRow[]>),
  createCheck: (id: string, input: { name: string; command?: string; enabled?: boolean; earnedNote?: string }) =>
    post(`/api/projects/${id}/checks`, input).then(json<VerifyCheckRow>),
  updateCheck: (id: string, checkId: string, patch: { enabled?: boolean; earnedNote?: string; command?: string }) =>
    fetch(`/api/projects/${id}/checks/${checkId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<VerifyCheckRow>),
  traceLinks: (id: string) =>
    fetch(`/api/projects/${id}/trace-links`).then(json<ProjectTraceLink[]>),
  createTraceLink: (
    id: string,
    input: {
      sourceType: TraceRefType;
      sourceId: string;
      targetType: TraceRefType;
      targetId: string;
      relation: TraceRelation;
      rationale: string;
    },
  ) => post(`/api/projects/${id}/trace-links`, input).then(json<ProjectTraceLink>),
  deleteTraceLink: async (id: string, linkId: string) => {
    const res = await fetch(`/api/projects/${id}/trace-links/${linkId}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(res.status, (body as { error?: string } | null)?.error ?? res.statusText);
    }
  },
};

// --- Claude Code control plane ---------------------------------------------------

export type CodingProvider = "anthropic" | "openai";
export type CodingBackend = "claude" | "aider";

export interface CodingProviderCapabilities {
  plan: boolean;
  execute: boolean;
  resume: boolean;
  effort: boolean;
  maxTurns: boolean;
  maxBudgetUsd: boolean;
  structuredEvents: boolean;
}

export interface CodingProviderRuntime {
  id: CodingProvider;
  label: string;
  backend: CodingBackend;
  authenticationConfigured: boolean;
  networkConfigured: boolean;
  runtimeConfigured: boolean;
  detectedCliVersion: string | null;
  ready: boolean;
  unavailableReason: string | null;
  defaultModel: string | null;
  modelOptions: string[];
  pinnedCliVersion: string;
  transport: string;
  capabilities: CodingProviderCapabilities;
  approvalBoundary: string;
}

export type ClaudeSessionRow = Omit<ClaudeSession, "createdAt" | "updatedAt"> & {
  provider: CodingProvider;
  backend: CodingBackend;
  createdAt: string;
  updatedAt: string;
};
export type ClaudeRunRow = Omit<ClaudeRun, "createdAt" | "updatedAt" | "startedAt" | "finishedAt"> & {
  provider: CodingProvider;
  backend: CodingBackend;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
export type ClaudeEventRow = Omit<ClaudeEvent, "createdAt"> & { createdAt: string };

export interface ClaudeCatalogModel {
  key: string;
  name: string;
  description: string;
  ids: { claudeApi: string; claudeApiAlias: string; amazonBedrock: string; googleCloud: string };
  pricing: {
    currency: string;
    unit: string;
    input?: number;
    output?: number;
    current?: { input: number; output: number; effectiveThrough: string; note: string };
    scheduledStandard?: { input: number; output: number; effectiveFrom: string };
  };
  contextTokens: number;
  maxOutputTokens: number;
  comparativeLatency: string;
  thinking: {
    adaptiveThinking: boolean;
    extendedThinking: boolean;
    adaptiveThinkingAlwaysOn?: boolean;
    canDisableThinking?: boolean;
    providerCaveat?: string;
    effortLevels: string[];
    defaultEffort: string | null;
  };
  cutoffs: { reliableKnowledge: string; trainingData: string };
}

export interface ClaudeCodeCatalog {
  schemaVersion: number;
  product: string;
  asOf: string;
  trustBoundary: { currentBehaviorAuthority: string; captureAuthority: string; rawPromptTextIncluded: boolean; captureUsage: string };
  sources: { id: string; authority: string; publisher: string; title: string; url: string }[];
  models: ClaudeCatalogModel[];
  aliases: { alias: string; kind: string; behavior: string; currentResolution: unknown }[];
  tools: {
    sourceAuthority: string;
    sourceId: string;
    permissionColumnMeaning: string;
    current: { name: string; category: string; permissionRequiredByDefault: boolean; summary: string; availability?: string }[];
    captureMappings: {
      sourceAuthority: string;
      sourcePath: string;
      sourceBlobSha: string;
      note: string;
      entries: { captured: string; current: string[]; relation: string; note?: string }[];
    };
  };
  permissionModes: {
    id: string;
    displayLabel: string;
    runsWithoutAsking: string;
    bestFor: string;
    controlPlanePolicy: string;
    controlPlaneReason: string;
  }[];
  extensions: { id: string; name: string; summary: string; typicalLocation: string; sourceAuthority: string; sourceId: string }[];
  provenance: {
    authority: string;
    repository: string;
    repositoryUrl: string;
    repositoryLicense: string;
    licenseCaveat: string;
    requestedPath: string;
    snapshotCommit: string;
    snapshotCommitDate: string;
    snapshotCommitUrl: string;
    snapshotTreeUrl: string;
    warning: string;
    countingMethod: string;
    rawPromptTextIncluded: boolean;
    documents: {
      path: string;
      blobSha: string;
      characterCount: number;
      lineCount: number;
      relevance: string;
      summary: string;
      url: string;
    }[];
  };
  runtime: {
    workbenchEnabled: boolean;
    providers: Record<CodingProvider, CodingProviderRuntime>;
    egressAllow?: string[];
    /** Legacy Anthropic-only runtime fields retained while older servers roll forward. */
    authenticationConfigured?: boolean;
    pinnedCliVersion?: string;
    transport?: string;
    granularToolApprovals: boolean;
    approvalBoundary?: string;
  };
}

export interface ClaudeRunInput {
  prompt: string;
  mode: "plan" | "execute";
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  permissionMode?: "acceptEdits";
  maxTurns?: number;
  maxBudgetUsd?: number | null;
  timeoutMs?: number;
}

export interface ClaudeNewSessionInput extends ClaudeRunInput {
  projectId: string;
  title?: string;
  /** Omitted remains Anthropic for backward compatibility. */
  provider?: CodingProvider;
}

export interface ClaudeWorkbench {
  status: "absent" | "running" | "stopped";
  gitStatus: string;
  diffStat: string;
  diff: string;
  error: string | null;
}

export const claudeCodeApi = {
  catalog: () => fetch("/api/claude-code/catalog").then(json<ClaudeCodeCatalog>),
  sessions: () => fetch("/api/claude-code/sessions").then(json<ClaudeSessionRow[]>),
  get: (id: string) =>
    fetch(`/api/claude-code/sessions/${id}`).then(
      json<{ session: ClaudeSessionRow; runs: ClaudeRunRow[] }>,
    ),
  events: (
    id: string,
    opts: { after?: number; before?: number; limit?: number; tail?: boolean } = {},
  ) => {
    const query = new URLSearchParams();
    if (opts.after !== undefined) query.set("after", String(opts.after));
    if (opts.before !== undefined) query.set("before", String(opts.before));
    if (opts.limit !== undefined) query.set("limit", String(opts.limit));
    if (opts.tail !== undefined) query.set("tail", String(opts.tail));
    return fetch(`/api/claude-code/sessions/${id}/events?${query}`).then(json<ClaudeEventRow[]>);
  },
  workbench: (id: string) =>
    fetch(`/api/claude-code/sessions/${id}/workbench`).then(json<ClaudeWorkbench>),
  create: (input: ClaudeNewSessionInput) =>
    post("/api/claude-code/sessions", input).then(
      json<{ session: ClaudeSessionRow; run: ClaudeRunRow; missionId: string }>,
    ),
  continue: (id: string, input: ClaudeRunInput) =>
    post(`/api/claude-code/sessions/${id}/messages`, input).then(
      json<{ session: ClaudeSessionRow; run: ClaudeRunRow; missionId: string }>,
    ),
  update: (id: string, patch: { title?: string; status?: "active" | "archived" }) =>
    fetch(`/api/claude-code/sessions/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then(json<ClaudeSessionRow>),
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
  workspaceId: string;
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
  workspaceId: string;
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

export type ScienceEventType =
  | "science.study.created"
  | "science.artifact.uploaded"
  | "science.artifact.ready"
  | "science.artifact.quarantined"
  | "science.run.awaiting_approval"
  | "science.run.queued"
  | "science.run.provisioning"
  | "science.run.started"
  | "science.run.progress"
  | "science.run.log"
  | "science.run.finalizing"
  | "science.run.succeeded"
  | "science.run.failed"
  | "science.run.cancelling"
  | "science.run.cancelled"
  | "science.render.starting"
  | "science.render.ready"
  | "science.render.heartbeat"
  | "science.render.expired"
  | "science.render.failed";

/** Bounded Science Operations projection carried over the existing event
 * stream. Durable run, artifact, and manifest state is still re-read by REST. */
export interface ScienceBusEvent {
  type: ScienceEventType;
  workspaceId: string;
  studyId?: string;
  runId?: string;
  missionId?: string;
  artifactVersionId?: string;
  renderSessionId?: string;
  sequence: number;
  at: string;
  state?: string;
  metadata?: Record<string, unknown>;
}

export type BusEvent =
  | ScienceBusEvent
  | { type: "mission.started"; missionId: string; agentId?: string; at: string }
  | { type: "agent.message"; agentId: string; missionId: string; role: string; text: string; at: string }
  | { type: "mission.finished"; missionId: string; status: string; at: string }
  | { type: "mission.step"; missionId: string; nodeId: string; kind: MissionStepKind; status: StepStatus; at: string }
  | { type: "approval.requested"; missionId: string; nodeId: string; approvalId: string; prompt: string; at: string }
  | { type: "approval.resolved"; missionId: string; approvalId: string; approved: boolean; at: string }
  | { type: "agent.message.delta"; agentId: string; missionId: string; delta: string; at: string }
  | { type: "claude.run.started"; sessionId: string; runId: string; missionId: string; model: string; mode: "plan" | "execute"; provider?: CodingProvider; backend?: CodingBackend; at: string }
  | { type: "claude.event"; sessionId: string; runId: string; missionId: string; seq: number; stream: "stdout" | "stderr" | "system"; eventType: string; provider?: CodingProvider; backend?: CodingBackend; text?: string; payload?: unknown; at: string }
  | { type: "claude.run.finished"; sessionId: string; runId: string; missionId: string; status: "succeeded" | "failed" | "cancelled"; provider?: CodingProvider; backend?: CodingBackend; costUsd?: number; at: string }
  | OpsVitals
  | AuditAppended;

export const watchApi = {
  vitals: () => fetch("/api/ops/vitals").then(json<{ samples: OpsVitals[] }>),
};
