import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  claudeCodeApi,
  projectApi,
  type ClaudeCodeCatalog,
  type ClaudeEventRow,
  type ClaudeRunInput,
  type ClaudeRunRow,
  type ClaudeSessionRow,
  type ClaudeWorkbench,
  type CodingProvider,
  type CodingProviderRuntime,
  type Project,
} from "../api.js";
import "./claude-code.css";

type CatalogTab = "session" | "models" | "tools" | "extensions" | "permissions" | "sources";
type SessionPanel = "transcript" | "tools" | "tasks" | "events" | "diff";

interface SessionBundle {
  session: ClaudeSessionRow;
  runs: ClaudeRunRow[];
}

interface ToolInvocation {
  id: string;
  runId: string;
  name: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
}

const LIVE_STATUSES = new Set(["queued", "awaiting_approval", "running"]);
const EVENT_WINDOW = 5_000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type EffortChoice = (typeof EFFORTS)[number];
const PROVIDERS: CodingProvider[] = ["anthropic", "openai"];

function normalizeProvider(value: unknown): CodingProvider {
  return value === "openai" ? "openai" : "anthropic";
}

function providerName(provider: CodingProvider): string {
  return provider === "openai" ? "OPENAI / AIDER" : "ANTHROPIC / CLAUDE CODE";
}

function agentName(provider: CodingProvider): string {
  return provider === "openai" ? "OPENAI / AIDER" : "CLAUDE";
}

function providerRuntime(
  catalog: ClaudeCodeCatalog | null,
  provider: CodingProvider,
): CodingProviderRuntime | null {
  return catalog?.runtime.providers?.[provider] ?? null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentBlocks(payload: unknown): Record<string, unknown>[] {
  const root = object(payload);
  if (!root) return [];
  const blocks: Record<string, unknown>[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const row = object(item);
        if (row) blocks.push(row);
      }
      return;
    }
    const row = object(value);
    if (row) blocks.push(row);
  };
  add(object(root.message)?.content);
  add(root.content);
  add(object(root.event)?.content_block);
  return blocks;
}

function displayValue(value: unknown, limit = 12_000): string {
  if (typeof value === "string") return value.slice(0, limit);
  try {
    const encoded = JSON.stringify(value, null, 2) ?? "null";
    return encoded.length > limit ? `${encoded.slice(0, limit)}\n... truncated ...` : encoded;
  } catch {
    return "[unserializable value]";
  }
}

function blockResult(block: Record<string, unknown>): unknown {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((item) => {
        const row = object(item);
        return typeof row?.text === "string" ? row.text : displayValue(item, 2_000);
      })
      .join("\n");
  }
  return block.content ?? null;
}

function extractTools(events: ClaudeEventRow[]): ToolInvocation[] {
  const rows: ToolInvocation[] = [];
  const byId = new Map<string, ToolInvocation>();
  const pendingResults = new Map<string, { output: unknown; isError: boolean }>();
  for (const event of events) {
    for (const block of contentBlocks(event.payload)) {
      if (block.type === "tool_use" && typeof block.name === "string") {
        const id = typeof block.id === "string" ? block.id : `${event.id}:${rows.length}`;
        let row = byId.get(id);
        if (!row) {
          row = { id, runId: event.runId, name: block.name, input: block.input ?? {} };
          rows.push(row);
          byId.set(id, row);
        } else {
          row.name = block.name;
          row.input = block.input ?? row.input;
        }
        const pending = pendingResults.get(id);
        if (pending) {
          row.output = pending.output;
          row.isError = pending.isError;
          pendingResults.delete(id);
        }
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        const output = blockResult(block);
        const isError = block.is_error === true;
        const target = byId.get(block.tool_use_id);
        if (target) {
          target.output = output;
          target.isError = isError;
        } else {
          pendingResults.set(block.tool_use_id, { output, isError });
        }
      }
    }
  }
  return rows;
}

function textFromEvent(event: ClaudeEventRow): string {
  const root = object(event.payload);
  if (typeof root?.text === "string") return root.text;
  const inner = object(root?.event);
  const delta = object(inner?.delta);
  if (delta?.type === "text_delta" && typeof delta.text === "string") return delta.text;
  for (const block of contentBlocks(event.payload)) {
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function runText(run: ClaudeRunRow, events: ClaudeEventRow[]): string {
  if (run.resultText) return run.resultText;
  const related = events.filter((event) => event.runId === run.id);
  const deltas = related
    .filter((event) => event.eventType.includes("text_delta"))
    .map(textFromEvent)
    .join("");
  if (deltas) return deltas;
  const assistant = related
    .filter((event) => event.eventType === "assistant")
    .map(textFromEvent)
    .filter(Boolean)
    .join("\n");
  if (assistant) return assistant;
  return related
    .filter((event) => event.eventType === "aider.output")
    .map(textFromEvent)
    .filter(Boolean)
    .join("");
}

function fmtDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function fmtTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

function fmtDuration(value: number | null): string {
  if (value === null) return "--";
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : "Unexpected request failure";
}

interface DurableFailureIds {
  sessionId?: string;
  runId?: string;
  missionId?: string;
}

function durableFailureIds(error: unknown): DurableFailureIds {
  if (!(error instanceof ApiError)) return {};
  const body = object(error.body);
  if (!body) return {};
  const session = object(body.session);
  const run = object(body.run);
  return {
    ...(typeof body.sessionId === "string"
      ? { sessionId: body.sessionId }
      : typeof session?.id === "string" ? { sessionId: session.id } : {}),
    ...(typeof body.runId === "string"
      ? { runId: body.runId }
      : typeof run?.id === "string" ? { runId: run.id } : {}),
    ...(typeof body.missionId === "string"
      ? { missionId: body.missionId }
      : typeof run?.missionId === "string" ? { missionId: run.missionId } : {}),
  };
}

function isQueueFailure(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 503) return false;
  const ids = durableFailureIds(error);
  return Boolean(ids.sessionId || ids.runId || ids.missionId) || /could not be queued|queue handoff failed/i.test(error.message);
}

function aggregateCost(runs: ClaudeRunRow[]): string {
  const known = runs.flatMap((run) => run.costUsd === null ? [] : [run.costUsd]);
  if (known.length === 0) return "--";
  const total = known.reduce((sum, cost) => sum + cost, 0);
  return known.length === runs.length ? `$${total.toFixed(4)}` : `$${total.toFixed(4)} + ?`;
}

function statusClass(status: string): string {
  if (status === "succeeded") return "ok";
  if (status === "failed") return "danger";
  if (status === "awaiting_approval") return "warn";
  return "neutral";
}

function pricing(model: ClaudeCodeCatalog["models"][number]): string {
  const price = model.pricing;
  const input = price.current?.input ?? price.input;
  const output = price.current?.output ?? price.output;
  return input === undefined || output === undefined ? "Provider pricing" : `$${input} / $${output} per MTok`;
}

function supportedEfforts(modelValue: string, catalog: ClaudeCodeCatalog | null): EffortChoice[] {
  const normalized = modelValue.trim().toLowerCase();
  const exact = catalog?.models.find((model) =>
    [model.key, model.name, model.ids.claudeApi, model.ids.claudeApiAlias]
      .some((value) => value.toLowerCase() === normalized),
  );
  if (exact) return exact.thinking.effortLevels.filter((value): value is EffortChoice => EFFORTS.includes(value as EffortChoice));
  if (normalized === "haiku" || normalized.includes("haiku")) return [];
  return [...EFFORTS];
}

type ComposerInput = ClaudeRunInput & {
  projectId?: string;
  title?: string;
  provider?: CodingProvider;
};

function RunComposer(props: {
  kind: "new" | "continue";
  projects: Project[];
  defaultProjectId: string;
  defaultProvider: CodingProvider;
  defaultModel: string;
  disabled: boolean;
  busy: boolean;
  modelOptions: Record<CodingProvider, string[]>;
  catalog: ClaudeCodeCatalog | null;
  onSubmit: (input: ComposerInput) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(props.defaultProjectId);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState<CodingProvider>(props.defaultProvider);
  const [mode, setMode] = useState<"plan" | "execute">("plan");
  const [model, setModel] = useState(props.defaultModel);
  const [effort, setEffort] = useState<"" | EffortChoice>("");
  const [maxTurns, setMaxTurns] = useState("24");
  const [budget, setBudget] = useState("5");
  const runtime = providerRuntime(props.catalog, provider);
  const capabilities = runtime?.capabilities;
  const supportsMode = mode === "plan" ? capabilities?.plan === true : capabilities?.execute === true;
  const ready = runtime?.ready === true;
  const selectedModelOptions = props.modelOptions[provider];

  useEffect(() => {
    if (!projectId && props.defaultProjectId) setProjectId(props.defaultProjectId);
  }, [projectId, props.defaultProjectId]);
  useEffect(() => {
    setProvider(normalizeProvider(props.defaultProvider));
  }, [props.defaultProvider]);
  useEffect(() => {
    if (props.defaultModel) setModel(props.defaultModel);
  }, [props.defaultModel]);
  useEffect(() => {
    if (mode === "plan" && capabilities && !capabilities.plan && capabilities.execute) setMode("execute");
    if (mode === "execute" && capabilities && !capabilities.execute && capabilities.plan) setMode("plan");
  }, [capabilities, mode]);
  const effortOptions = useMemo(
    () => capabilities?.effort ? supportedEfforts(model, props.catalog) : [],
    [capabilities?.effort, model, props.catalog],
  );
  useEffect(() => {
    if (effort && !effortOptions.includes(effort)) setEffort("");
  }, [effort, effortOptions]);

  const changeProvider = (next: CodingProvider) => {
    const nextRuntime = providerRuntime(props.catalog, next);
    setProvider(next);
    setModel(nextRuntime?.defaultModel ?? props.modelOptions[next][0] ?? (next === "anthropic" ? "sonnet" : ""));
    setEffort("");
    setMode(nextRuntime?.capabilities.plan ? "plan" : "execute");
  };

  const blocked = props.disabled || props.busy || !ready || !supportsMode || !prompt.trim() || !model.trim();
  const limitations = provider === "openai" && capabilities
    ? [
        !capabilities.plan && "NO READ-ONLY PLAN",
        !capabilities.resume && "NO CLI SESSION RESUME",
        !capabilities.structuredEvents && "PLAIN OUTPUT EVENTS",
        !capabilities.effort && "NO EFFORT CONTROL",
        !capabilities.maxTurns && "NO TURN CAP",
        !capabilities.maxBudgetUsd && "NO SPEND CAP",
      ].filter(Boolean)
    : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    try {
      await props.onSubmit({
        prompt: prompt.trim(),
        mode,
        model: model.trim(),
        ...(capabilities?.effort ? { effort: effort || null } : {}),
        ...(provider === "anthropic" && mode === "execute" ? { permissionMode: "acceptEdits" as const } : {}),
        ...(capabilities?.maxTurns
          ? { maxTurns: Math.max(1, Math.min(100, Number(maxTurns) || 24)) }
          : {}),
        ...(capabilities?.maxBudgetUsd
          ? { maxBudgetUsd: budget.trim() && Number.isFinite(Number(budget)) ? Number(budget) : null }
          : {}),
        timeoutMs: 900_000,
        ...(props.kind === "new"
          ? {
              projectId,
              provider,
              ...(title.trim() ? { title: title.trim() } : {}),
            }
          : {}),
      });
    } catch {
      return;
    }
    setPrompt("");
    if (props.kind === "new") setTitle("");
  };

  return (
    <form className="cc-composer" onSubmit={submit}>
      {props.kind === "new" ? (
        <div className="cc-form-grid cc-form-grid-3">
          <label>
            <span>PROVIDER</span>
            <select value={provider} onChange={(event) => changeProvider(event.target.value as CodingProvider)}>
              {PROVIDERS.map((value) => (
                <option key={value} value={value}>
                  {providerRuntime(props.catalog, value)?.label ?? providerName(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>PROJECT</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
              {props.projects.length === 0 && <option value="">No projects available</option>}
              {props.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <label>
            <span>SESSION TITLE <i>OPTIONAL</i></span>
            <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="Derived from the first prompt" />
          </label>
        </div>
      ) : (
        <div className="cc-provider-lock">
          <span>PROVIDER LOCKED FOR THIS SESSION</span>
          <b>{runtime?.label ?? providerName(provider)}</b>
          <i>{runtime?.backend.toUpperCase() ?? "--"}</i>
        </div>
      )}
      <label className="cc-prompt-field">
        <span>{props.kind === "new" ? "INITIAL INSTRUCTION" : "NEXT INSTRUCTION"}</span>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={mode === "plan" ? "Inspect the repository and produce an evidence-backed implementation plan..." : "Implement the approved change and verify it..."}
          rows={props.kind === "new" ? 5 : 4}
          maxLength={100_000}
          required
        />
      </label>
      <div className="cc-form-grid cc-form-grid-controls">
        <label>
          <span>MODE</span>
          <select value={mode} onChange={(event) => setMode(event.target.value as "plan" | "execute")}>
            <option value="plan" disabled={!capabilities?.plan}>Plan / read-only</option>
            <option value="execute" disabled={!capabilities?.execute}>Execute / gated edits</option>
          </select>
        </label>
        <label>
          <span>MODEL</span>
          <input
            list={`cc-models-${props.kind}-${provider}`}
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={provider === "openai" ? "openai/<model>" : "sonnet"}
            required
          />
          <datalist id={`cc-models-${props.kind}-${provider}`}>
            {selectedModelOptions.map((value) => <option key={value} value={value} />)}
          </datalist>
        </label>
        {capabilities?.effort && (
          <label>
            <span>EFFORT</span>
            <select value={effort} onChange={(event) => setEffort(event.target.value as typeof effort)}>
              <option value="">Model default</option>
              {effortOptions.map((value) => (
                <option key={value} value={value}>{value === "xhigh" ? "Extra high" : value === "max" ? "Maximum" : value[0]!.toUpperCase() + value.slice(1)}</option>
              ))}
            </select>
          </label>
        )}
        {capabilities?.maxTurns && (
          <label>
            <span>MAX TURNS</span>
            <input type="number" min={1} max={100} value={maxTurns} onChange={(event) => setMaxTurns(event.target.value)} />
          </label>
        )}
        {capabilities?.maxBudgetUsd && (
          <label>
            <span>BUDGET USD</span>
            <input type="number" min="0.01" max="100" step="0.01" value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="No cap" />
          </label>
        )}
      </div>
      <div className={`cc-provider-status ${ready ? "ready" : "blocked"}`}>
        <b>{runtime?.label ?? providerName(provider)}</b>
        <span>
          {ready
            ? `${runtime?.transport ?? "runtime"}${limitations.length > 0 ? ` // ${limitations.join(" // ")}` : ""}`
            : runtime?.unavailableReason ?? "Provider runtime metadata is not available."}
        </span>
      </div>
      <div className="cc-submit-row">
        <span className={mode === "execute" ? "cc-boundary warn" : "cc-boundary"}>
          {runtime?.approvalBoundary ?? (mode === "execute"
            ? "Execute waits for one Puppetmaster write approval, then edits only inside the isolated workbench."
            : "Plan is read-only and does not request a write approval.")}
        </span>
        <button className="fui-chip" type="submit" disabled={blocked}>
          {props.busy ? "QUEUING..." : mode === "execute" ? "REQUEST EXECUTION" : "QUEUE PLAN"}
        </button>
      </div>
    </form>
  );
}

export function ClaudeCodeView(props: { canBuild: boolean; refreshKey: number; onTrack: (missionId: string) => void }) {
  const [catalog, setCatalog] = useState<ClaudeCodeCatalog | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<ClaudeSessionRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<SessionBundle | null>(null);
  const [events, setEvents] = useState<ClaudeEventRow[]>([]);
  const [workbench, setWorkbench] = useState<ClaudeWorkbench | null>(null);
  const [workbenchRefreshError, setWorkbenchRefreshError] = useState<string | null>(null);
  const [tab, setTab] = useState<CatalogTab>("session");
  const [sessionPanel, setSessionPanel] = useState<SessionPanel>("transcript");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settledRefresh, setSettledRefresh] = useState(props.refreshKey);
  const [hasEarlierEvents, setHasEarlierEvents] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [followingEventTail, setFollowingEventTail] = useState(true);
  const eventCursor = useRef(0);
  const eventsRef = useRef<ClaudeEventRow[]>([]);
  const loadedSession = useRef<string | null>(null);
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    const remaining = Math.max(0, 250 - (Date.now() - lastRefreshAt.current));
    const timer = window.setTimeout(() => {
      lastRefreshAt.current = Date.now();
      setSettledRefresh(props.refreshKey);
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [props.refreshKey]);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    Promise.all([claudeCodeApi.catalog(), projectApi.list(), claudeCodeApi.sessions()])
      .then(([catalogRow, projectRows, sessionRows]) => {
        if (ignore) return;
        setCatalog(catalogRow);
        setProjects(projectRows.filter((project) => project.status === "active"));
        setSessions(sessionRows);
        setSelectedId((current) => current ?? sessionRows[0]?.id ?? null);
        setError(null);
      })
      .catch((requestError) => {
        if (!ignore) setError(errorMessage(requestError));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    if (settledRefresh === 0) return;
    claudeCodeApi.sessions().then(setSessions).catch(() => {});
  }, [settledRefresh]);

  useEffect(() => {
    if (!selectedId) {
      setBundle(null);
      setEvents([]);
      eventsRef.current = [];
      setWorkbench(null);
      setWorkbenchRefreshError(null);
      eventCursor.current = 0;
      loadedSession.current = null;
      setHasEarlierEvents(false);
      setFollowingEventTail(true);
      return;
    }
    let ignore = false;
    setLoading(true);
    setBundle(null);
    setEvents([]);
    eventsRef.current = [];
    setWorkbench(null);
    setWorkbenchRefreshError(null);
    eventCursor.current = 0;
    loadedSession.current = null;
    setFollowingEventTail(true);
    Promise.all([
      claudeCodeApi.get(selectedId),
      claudeCodeApi.events(selectedId, { tail: true, limit: 2_000 }),
      claudeCodeApi.workbench(selectedId).catch((requestError): ClaudeWorkbench => ({
        status: "absent",
        gitStatus: "",
        diffStat: "",
        diff: "",
        error: errorMessage(requestError),
      })),
    ])
      .then(([detail, eventRows, bench]) => {
        if (ignore) return;
        setBundle(detail);
        eventsRef.current = eventRows;
        setEvents(eventRows);
        eventCursor.current = eventRows.at(-1)?.sequence ?? 0;
        setHasEarlierEvents((eventRows[0]?.sequence ?? 1) > 1);
        loadedSession.current = selectedId;
        setWorkbench(bench);
        setWorkbenchRefreshError(null);
        setError(null);
      })
      .catch((requestError) => {
        if (!ignore) setError(errorMessage(requestError));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => { ignore = true; };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || loadedSession.current !== selectedId) return;
    let ignore = false;
    const after = eventCursor.current;
    Promise.all([
      claudeCodeApi.get(selectedId),
      // Fetch the oldest page after the durable cursor. Combining `after` with
      // `tail` can jump over a busy interval and make that gap unrecoverable.
      claudeCodeApi.events(selectedId, { after, limit: 2_000 }),
      claudeCodeApi.workbench(selectedId)
        .then((bench) => ({ bench, error: null as string | null }))
        .catch((requestError) => ({ bench: null, error: errorMessage(requestError) })),
    ])
      .then(([detail, incoming, inspection]) => {
        if (ignore) return;
        setBundle(detail);
        if (incoming.length > 0) {
          eventCursor.current = Math.max(after, incoming.at(-1)?.sequence ?? after);
          if (followingEventTail) {
            const known = new Set(eventsRef.current.map((event) => event.sequence));
            const next = [...eventsRef.current, ...incoming.filter((event) => !known.has(event.sequence))]
              .sort((a, b) => a.sequence - b.sequence)
              .slice(-EVENT_WINDOW);
            eventsRef.current = next;
            setEvents(next);
            setHasEarlierEvents((next[0]?.sequence ?? 1) > 1);
          }
          // Drain a full page even if no later websocket event arrives.
          if (incoming.length === 2_000) setSettledRefresh((value) => value + 1);
        }
        if (inspection.bench) {
          setWorkbench(inspection.bench);
          setWorkbenchRefreshError(null);
        } else {
          setWorkbenchRefreshError(inspection.error);
        }
      })
      .catch(() => {});
    return () => { ignore = true; };
  }, [selectedId, settledRefresh, followingEventTail]);

  const modelOptions = useMemo<Record<CodingProvider, string[]>>(() => {
    const anthropicRuntime = providerRuntime(catalog, "anthropic");
    const openaiRuntime = providerRuntime(catalog, "openai");
    return {
      anthropic: [...new Set([
        "sonnet",
        "opus",
        "haiku",
        ...(anthropicRuntime?.defaultModel ? [anthropicRuntime.defaultModel] : []),
        ...(anthropicRuntime?.modelOptions ?? []),
        ...(catalog?.aliases.map((alias) => alias.alias) ?? []),
        ...(catalog?.models.map((model) => model.ids.claudeApi) ?? []),
      ])],
      openai: [...new Set([
        ...(openaiRuntime?.defaultModel ? [openaiRuntime.defaultModel] : []),
        ...(openaiRuntime?.modelOptions ?? []),
      ])],
    };
  }, [catalog]);

  const toolRows = useMemo(() => extractTools(events), [events]);
  const taskRows = useMemo(
    () => toolRows.filter((row) => /^(Agent|Workflow|Task|SendMessage|ScheduleWakeup)/.test(row.name)),
    [toolRows],
  );
  const activeRun = bundle?.runs.find((run) => LIVE_STATUSES.has(run.status)) ?? null;
  const defaultProjectId = projects[0]?.id ?? "";
  const runtimeEnabled = catalog?.runtime.workbenchEnabled === true;
  const providerRuntimes = PROVIDERS
    .map((provider) => providerRuntime(catalog, provider))
    .filter((runtime): runtime is CodingProviderRuntime => runtime !== null);
  const readyRuntimes = providerRuntimes.filter((runtime) => runtime.ready);
  const runtimeReady = runtimeEnabled && readyRuntimes.length > 0;
  const mutationDisabled = !props.canBuild || !runtimeEnabled || projects.length === 0;
  const selectedProvider = normalizeProvider(bundle?.session.provider);

  useEffect(() => {
    if (!activeRun) return;
    const timer = window.setInterval(() => setSettledRefresh((value) => value + 1), 2_000);
    return () => window.clearInterval(timer);
  }, [activeRun?.id]);

  const refreshSessions = async (select?: string) => {
    const rows = await claudeCodeApi.sessions();
    setSessions(rows);
    if (select) setSelectedId(select);
    setSettledRefresh((value) => value + 1);
  };

  const createSession = async (input: ComposerInput) => {
    if (!input.projectId) return;
    setBusy(true);
    setError(null);
    try {
      const created = await claudeCodeApi.create({
        ...input,
        projectId: input.projectId,
        provider: input.provider ?? "anthropic",
      });
      await refreshSessions(created.session.id);
      setTab("session");
      setSessionPanel("transcript");
      props.onTrack(created.missionId);
    } catch (requestError) {
      setError(errorMessage(requestError));
      if (isQueueFailure(requestError)) {
        const ids = durableFailureIds(requestError);
        await refreshSessions(ids.sessionId).catch(() => {});
        if (ids.sessionId) {
          setTab("session");
          setSessionPanel("transcript");
        }
      }
      throw requestError;
    } finally {
      setBusy(false);
    }
  };

  const continueSession = async (input: ComposerInput) => {
    if (!selectedId || bundle?.session.id !== selectedId) throw new Error("Session selection changed; review and submit again");
    setBusy(true);
    setError(null);
    try {
      const turn: ClaudeRunInput = {
        prompt: input.prompt,
        mode: input.mode,
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxBudgetUsd,
        timeoutMs: input.timeoutMs,
      };
      const created = await claudeCodeApi.continue(selectedId, turn);
      setSettledRefresh((value) => value + 1);
      props.onTrack(created.missionId);
    } catch (requestError) {
      setError(errorMessage(requestError));
      if (isQueueFailure(requestError)) {
        const ids = durableFailureIds(requestError);
        await refreshSessions(ids.sessionId ?? selectedId).catch(() => {});
      }
      throw requestError;
    } finally {
      setBusy(false);
    }
  };

  const loadEarlierEvents = async () => {
    const sessionId = selectedId;
    const firstSequence = eventsRef.current[0]?.sequence;
    if (!sessionId || loadingEarlier || firstSequence === undefined) return;
    setLoadingEarlier(true);
    try {
      const earlier = await claudeCodeApi.events(sessionId, {
        before: firstSequence,
        limit: 1_000,
      });
      if (loadedSession.current !== sessionId) return;
      const known = new Set(eventsRef.current.map((event) => event.sequence));
      const merged = [...earlier.filter((event) => !known.has(event.sequence)), ...eventsRef.current]
        .sort((a, b) => a.sequence - b.sequence);
      // Explicit history navigation may slide the bounded display backwards,
      // but the independent live cursor remains at the newest fetched event.
      const next = merged.length > EVENT_WINDOW ? merged.slice(0, EVENT_WINDOW) : merged;
      eventsRef.current = next;
      setEvents(next);
      setHasEarlierEvents((next[0]?.sequence ?? 1) > 1);
      setFollowingEventTail((next.at(-1)?.sequence ?? 0) >= eventCursor.current);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const returnToLatestEvents = async () => {
    const sessionId = selectedId;
    if (!sessionId || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const latest = await claudeCodeApi.events(sessionId, { tail: true, limit: 2_000 });
      if (loadedSession.current !== sessionId) return;
      eventsRef.current = latest;
      setEvents(latest);
      eventCursor.current = Math.max(eventCursor.current, latest.at(-1)?.sequence ?? 0);
      setHasEarlierEvents((latest[0]?.sequence ?? 1) > 1);
      setFollowingEventTail(true);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const toggleArchive = async () => {
    if (!bundle || !props.canBuild || activeRun) return;
    setBusy(true);
    try {
      const status = bundle.session.status === "active" ? "archived" : "active";
      const updated = await claudeCodeApi.update(bundle.session.id, { status });
      setBundle({ ...bundle, session: updated });
      await refreshSessions(updated.id);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: CatalogTab; label: string; count?: number }[] = [
    { id: "session", label: "OPERATE", count: sessions.length },
    { id: "models", label: "MODELS", count: catalog?.models.length },
    { id: "tools", label: "TOOLS", count: catalog?.tools.current.length },
    { id: "extensions", label: "EXTENSIONS", count: catalog?.extensions.length },
    { id: "permissions", label: "PERMISSIONS", count: catalog?.permissionModes.length },
    { id: "sources", label: "SOURCES", count: catalog?.sources.length },
  ];

  return (
    <section className="cc-root" aria-label="Claude Code control plane">
      <header className="cc-mast">
        <div>
          <span className="cc-eyebrow">COMPATIBILITY CONTROL PLANE // ISOLATED RUNTIME</span>
          <h1>CLAUDE CODE</h1>
        </div>
        <div className="cc-runtime">
          <span aria-hidden="true" className={`cc-led ${runtimeReady ? "on" : ""}`} />
          <span>
            {runtimeReady
              ? `${readyRuntimes.map((runtime) => runtime.id.toUpperCase()).join(" + ")} READY`
              : runtimeEnabled ? "DOCKER RUNTIME CONFIGURED" : "DOCKER RUNTIME OFFLINE"}
          </span>
          {providerRuntimes.map((runtime) => (
            <b key={runtime.id}>{runtime.backend.toUpperCase()} {runtime.pinnedCliVersion}</b>
          ))}
        </div>
      </header>

      <div className="cc-notice" role="note">
        <strong>AUTHORITY BOUNDARY</strong>
        <span>Claude reference data is curated from official Anthropic documentation. OpenAI sessions use the separately pinned Aider backend and server-side OpenAI credentials; no captured prompt text executes here.</span>
      </div>

      <nav className="cc-tabs" aria-label="Claude Code sections" role="tablist">
        {tabs.map((item) => (
          <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? "on" : ""} onClick={() => setTab(item.id)}>
            {item.label}{item.count !== undefined && <span>{item.count}</span>}
          </button>
        ))}
      </nav>

      {error && <div className="cc-error" role="alert"><strong>REQUEST FAILED</strong><span>{error}</span><button onClick={() => setError(null)}>DISMISS</button></div>}
      {!props.canBuild && <div className="cc-readonly">READ-ONLY ROLE // Builder access is required to start, continue, or archive sessions.</div>}
      {catalog && !runtimeEnabled && <div className="cc-readonly warn">RUNTIME DISABLED // Set WORKBENCH_MODE=docker and configure provider credentials before starting sessions.</div>}
      {catalog && runtimeEnabled && providerRuntimes.filter((runtime) => !runtime.ready).map((runtime) => (
        <div className="cc-readonly warn" key={runtime.id}>
          <strong>{runtime.label.toUpperCase()} UNAVAILABLE</strong>
          <span>
            {runtime.unavailableReason
              ?? (!runtime.authenticationConfigured
                ? "Provider authentication is not configured for the workbench."
                : !runtime.networkConfigured
                  ? "The provider API host is not allowed by WORKBENCH_EGRESS_ALLOW."
                  : !runtime.runtimeConfigured
                    ? "The pinned coding CLI is unavailable in the configured workbench image."
                    : "The provider runtime is not ready.")}
          </span>
        </div>
      ))}

      <div className={`cc-content ${tab === "session" ? "operate" : "reference"}`}>
        {tab === "session" && (
          <>
            <aside className="cc-session-rail">
              <details className="cc-new-session" open={sessions.length === 0}>
                <summary>+ NEW SESSION</summary>
                <RunComposer
                  kind="new"
                  projects={projects}
                  defaultProjectId={defaultProjectId}
                  defaultProvider="anthropic"
                  defaultModel="sonnet"
                  disabled={mutationDisabled}
                  busy={busy}
                  modelOptions={modelOptions}
                  catalog={catalog}
                  onSubmit={createSession}
                />
              </details>
              <div className="cc-rail-head"><span>SESSIONS</span><b>{sessions.length}</b></div>
              <div className="cc-session-list">
                {sessions.length === 0 && <p>No durable sessions yet.</p>}
                {sessions.map((session) => (
                  <button key={session.id} aria-pressed={selectedId === session.id} className={selectedId === session.id ? "on" : ""} onClick={() => setSelectedId(session.id)}>
                    <span className="cc-session-title">{session.title}</span>
                    <span className="cc-session-meta">
                      <i aria-hidden="true" className={`cc-mini-led ${session.status}`} />
                      {session.status.toUpperCase()} // {agentName(normalizeProvider(session.provider))} // {session.model} // {fmtDate(session.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            </aside>

            <main className="cc-session-main">
              {!bundle && !loading && (
                <div className="cc-empty"><b>NO SESSION SELECTED</b><span>Create a session or select a durable session from the rail.</span></div>
              )}
              {loading && !bundle && <div className="cc-empty"><b>SYNCING SESSION LOG...</b></div>}
              {bundle && bundle.session.id === selectedId && (
                <>
                  <header className="cc-session-header">
                    <div>
                      <span className="cc-eyebrow">SESSION {bundle.session.id.slice(0, 8)} // PROJECT {bundle.session.projectId.slice(0, 8)}</span>
                      <h2>{bundle.session.title}</h2>
                      <p>
                        {providerName(selectedProvider)} // {bundle.session.model}
                        {selectedProvider === "anthropic"
                          ? ` // ${bundle.session.effort ?? "default effort"} // external ${bundle.session.claudeSessionId ?? "pending init"}`
                          : ` // ${bundle.session.backend.toUpperCase()} BACKEND // NO CLI SESSION RESUME`}
                      </p>
                    </div>
                    <div className="cc-session-actions">
                      {activeRun && <button className="fui-chip" onClick={() => props.onTrack(activeRun.missionId)}>TRACK MISSION</button>}
                      <button className="fui-chip" onClick={toggleArchive} disabled={!props.canBuild || Boolean(activeRun) || busy}>
                        {bundle.session.status === "active" ? "ARCHIVE" : "RESTORE"}
                      </button>
                    </div>
                  </header>

                  <div className="cc-metrics">
                    <div><span>STATUS</span><b>{bundle.session.status.toUpperCase()}</b></div>
                    <div><span>TURNS</span><b>{bundle.runs.length}</b></div>
                    <div><span>EVENTS LOADED</span><b>{events.length}</b></div>
                    <div><span>COST</span><b>{aggregateCost(bundle.runs)}</b></div>
                    <div><span>WORKBENCH</span><b>{workbench?.status.toUpperCase() ?? "--"}{workbenchRefreshError ? " / STALE" : ""}</b></div>
                  </div>

                  <nav className="cc-subtabs" aria-label="Session detail" role="tablist">
                    {([
                      ["transcript", "TRANSCRIPT", bundle.runs.length],
                      ["tools", "TOOL CALLS", toolRows.length],
                      ["tasks", "AGENTS / TASKS", taskRows.length],
                      ["events", "RAW EVENTS", events.length],
                      ["diff", "WORKBENCH DIFF", workbench?.diff ? 1 : 0],
                    ] as const).map(([id, label, count]) => (
                      <button key={id} role="tab" aria-selected={sessionPanel === id} className={sessionPanel === id ? "on" : ""} onClick={() => setSessionPanel(id)}>
                        {label}<span>{count}</span>
                      </button>
                    ))}
                  </nav>

                  {(hasEarlierEvents || !followingEventTail) && (
                    <div className="cc-event-window">
                      <span>
                        {followingEventTail ? "EVENT WINDOW" : "HISTORICAL WINDOW"} // Showing {events.length.toLocaleString()} bounded records. {followingEventTail ? "Earlier records remain durable." : "The live tail remains durable; return to latest to resume it."}
                      </span>
                      <button
                        className="fui-chip tiny"
                        onClick={followingEventTail ? loadEarlierEvents : returnToLatestEvents}
                        disabled={loadingEarlier}
                      >
                        {loadingEarlier ? "LOADING..." : followingEventTail ? "LOAD EARLIER" : "RETURN TO LATEST"}
                      </button>
                    </div>
                  )}

                  <div className="cc-session-scroll">
                    {sessionPanel === "transcript" && (
                      <div className="cc-transcript">
                        {bundle.runs.map((run) => {
                          const text = runText(run, events);
                          const usage = run.usage;
                          return (
                            <article className="cc-turn" key={run.id}>
                              <header>
                                <span>TURN {String(run.turnNumber).padStart(2, "0")} // {run.mode.toUpperCase()}</span>
                                <button onClick={() => props.onTrack(run.missionId)}>MISSION {run.missionId.slice(0, 8)}</button>
                                <b className={statusClass(run.status)}>{run.status.replace(/_/g, " ").toUpperCase()}</b>
                              </header>
                              <div className="cc-message user"><span>OPERATOR</span><pre>{run.prompt}</pre></div>
                              <div className="cc-message assistant">
                                <span>{agentName(normalizeProvider(run.provider))} // {run.model}</span>
                                <pre>{text || (LIVE_STATUSES.has(run.status) ? "Waiting for streamed output..." : run.error ?? "No result text was emitted.")}</pre>
                              </div>
                              {run.error && (
                                <div className="cc-message error">
                                  <span>RUN ERROR</span>
                                  <pre>{run.error}</pre>
                                </div>
                              )}
                              <footer>
                                <span>{usage ? `${fmtTokens(usage.inputTokens)} IN / ${fmtTokens(usage.outputTokens)} OUT` : "TOKENS --"}</span>
                                <span>{run.costUsd === null ? "COST --" : `$${run.costUsd.toFixed(4)}`}</span>
                                <span>{fmtDuration(run.durationMs)}</span>
                                <span>{run.numTurns ?? "--"} CLI TURNS</span>
                              </footer>
                            </article>
                          );
                        })}
                        {bundle.runs.length === 0 && <div className="cc-empty"><b>NO TURNS RECORDED</b></div>}
                      </div>
                    )}

                    {sessionPanel === "tools" && (
                      <div className="cc-tool-log">
                        {toolRows.map((row, index) => (
                          <article key={`${row.id}:${index}`}>
                            <header><b>{row.name}</b><span>{row.id}</span></header>
                            <div><span>INPUT</span><pre>{displayValue(row.input)}</pre></div>
                            {row.output !== undefined && <div className={row.isError ? "error" : ""}><span>{row.isError ? "ERROR" : "RESULT"}</span><pre>{displayValue(row.output)}</pre></div>}
                          </article>
                        ))}
                        {toolRows.length === 0 && <div className="cc-empty"><b>NO TOOL CALLS DECODED</b><span>Unknown schemas remain available in Raw Events.</span></div>}
                      </div>
                    )}

                    {sessionPanel === "tasks" && (
                      <div className="cc-tool-log">
                        {taskRows.map((row, index) => (
                          <article key={`${row.id}:${index}`} className="task">
                            <header><b>{row.name}</b><span>RUN {row.runId.slice(0, 8)}</span></header>
                            <div><span>DISPATCH</span><pre>{displayValue(row.input)}</pre></div>
                            {row.output !== undefined && <div><span>OUTCOME</span><pre>{displayValue(row.output)}</pre></div>}
                          </article>
                        ))}
                        {taskRows.length === 0 && <div className="cc-empty"><b>NO SUBAGENT OR TASK ACTIVITY</b><span>Agent, Workflow, Task, and teammate calls appear here when emitted by the CLI.</span></div>}
                      </div>
                    )}

                    {sessionPanel === "events" && (
                      <div className="cc-event-log">
                        {events.map((event) => (
                          <details key={event.id}>
                            <summary>
                              <span>{String(event.sequence).padStart(5, "0")}</span>
                              <b>{event.eventType}</b>
                              <i>{event.stream}</i>
                              <time>{fmtDate(event.createdAt)}</time>
                            </summary>
                            <pre>{event.payload === null ? event.raw : displayValue(event.payload, 40_000)}</pre>
                          </details>
                        ))}
                        {events.length === 0 && <div className="cc-empty"><b>NO EVENTS PERSISTED</b></div>}
                      </div>
                    )}

                    {sessionPanel === "diff" && (
                      <div className="cc-diff">
                        <div className="cc-diff-status">
                          <b>WORKBENCH {workbench?.status.toUpperCase() ?? "UNKNOWN"}</b>
                          <span>
                            {workbenchRefreshError
                              ? `Inspection refresh failed; showing the last successful snapshot: ${workbenchRefreshError}`
                              : workbench?.error ?? "Inspection is read-only; no host subprocess is used."}
                          </span>
                        </div>
                        <h3>GIT STATUS</h3><pre>{workbench?.gitStatus || "No status output."}</pre>
                        <h3>DIFF STAT</h3><pre>{workbench?.diffStat || "No changed files."}</pre>
                        <h3>PATCH</h3><pre className="patch">{workbench?.diff || "No unstaged diff."}</pre>
                      </div>
                    )}

                    {bundle.session.status === "active" && (
                      <section className="cc-continue">
                        <h3>NEXT TURN</h3>
                        <RunComposer
                          kind="continue"
                          projects={projects}
                          defaultProjectId={bundle.session.projectId}
                          defaultProvider={selectedProvider}
                          defaultModel={bundle.session.model}
                          disabled={!props.canBuild || !runtimeEnabled || Boolean(activeRun)}
                          busy={busy}
                          modelOptions={modelOptions}
                          catalog={catalog}
                          onSubmit={(input) => continueSession(input)}
                        />
                        {activeRun && <p>Turn {activeRun.turnNumber} is {activeRun.status.replace(/_/g, " ")}; only one turn can run per durable session.</p>}
                      </section>
                    )}
                  </div>
                </>
              )}
            </main>
          </>
        )}

        {tab === "models" && catalog && (
          <div className="cc-reference-grid cc-model-grid">
            {catalog.models.map((model) => (
              <article key={model.key}>
                <span className="cc-eyebrow">{model.comparativeLatency.toUpperCase()} // {model.key.toUpperCase()}</span>
                <h2>{model.name}</h2>
                <p>{model.description}</p>
                <dl>
                  <dt>API ID</dt><dd>{model.ids.claudeApi}</dd>
                  <dt>CONTEXT</dt><dd>{fmtTokens(model.contextTokens)} tokens</dd>
                  <dt>MAX OUTPUT</dt><dd>{fmtTokens(model.maxOutputTokens)} tokens</dd>
                  <dt>PRICE IN / OUT</dt><dd>{pricing(model)}</dd>
                  <dt>THINKING</dt><dd>{model.thinking.adaptiveThinking ? "Adaptive" : model.thinking.extendedThinking ? "Extended" : "Standard"}</dd>
                  <dt>EFFORT</dt><dd>{model.thinking.effortLevels.join(" / ") || "Not applicable"}</dd>
                </dl>
                {model.thinking.providerCaveat && <small>{model.thinking.providerCaveat}</small>}
                {model.pricing.current && <small>{model.pricing.current.note} Through {model.pricing.current.effectiveThrough}; scheduled standard ${model.pricing.scheduledStandard?.input ?? "?"} / ${model.pricing.scheduledStandard?.output ?? "?"} per MTok.</small>}
              </article>
            ))}
            <section className="cc-wide-card">
              <h2>MODEL ALIASES</h2>
              <div className="cc-alias-list">
                {catalog.aliases.map((alias) => <div key={alias.alias}><b>{alias.alias}</b><span>{alias.behavior}</span><code>{displayValue(alias.currentResolution, 1_000)}</code></div>)}
              </div>
            </section>
          </div>
        )}

        {tab === "tools" && catalog && (
          <div className="cc-reference-stack">
            <section className="cc-wide-card">
              <span className="cc-eyebrow">OFFICIAL CURRENT VOCABULARY // {catalog.tools.current.length} TOOLS</span>
              <h2>TOOL SURFACE</h2>
              <p>{catalog.tools.permissionColumnMeaning}</p>
              <div className="cc-tool-catalog">
                {catalog.tools.current.map((tool) => (
                  <article key={tool.name}>
                    <header><b>{tool.name}</b><span>{tool.category}</span><i className={tool.permissionRequiredByDefault ? "warn" : ""}>{tool.permissionRequiredByDefault ? "PROMPTS" : "NO DEFAULT PROMPT"}</i></header>
                    <p>{tool.summary}</p>{tool.availability && <small>{tool.availability}</small>}
                  </article>
                ))}
              </div>
            </section>
            <section className="cc-wide-card cc-capture-card">
              <span className="cc-eyebrow">UNVERIFIED CAPTURE MAPPING // NOT RUNTIME AUTHORITY</span>
              <h2>HISTORICAL NAME CROSSWALK</h2>
              <p>{catalog.tools.captureMappings.note}</p>
              <div className="cc-mapping-list">
                {catalog.tools.captureMappings.entries.map((row) => <div key={row.captured}><b>{row.captured}</b><span>{row.relation.replace(/_/g, " ")}</span><code>{row.current.join(" + ")}</code><p>{row.note}</p></div>)}
              </div>
            </section>
          </div>
        )}

        {tab === "extensions" && catalog && (
          <div className="cc-reference-grid">
            {catalog.extensions.map((extension) => (
              <article key={extension.id}>
                <span className="cc-eyebrow">{extension.id.toUpperCase()}</span>
                <h2>{extension.name}</h2><p>{extension.summary}</p>
                <code>{extension.typicalLocation}</code><small>Authority: {extension.sourceAuthority} / {extension.sourceId}</small>
              </article>
            ))}
          </div>
        )}

        {tab === "permissions" && catalog && (
          <div className="cc-reference-stack">
            <section className="cc-wide-card">
              <span className="cc-eyebrow">TWO-LAYER AUTHORIZATION</span><h2>PERMISSION MODES</h2>
              <p>Claude Code permission modes remain inside Puppetmaster's container and mission boundary. This control plane exposes Plan and approved acceptEdits execution only; bypassPermissions is prohibited.</p>
              <div className="cc-permission-list">
                {catalog.permissionModes.map((mode) => (
                  <article key={mode.id} className={mode.controlPlanePolicy === "prohibited" ? "prohibited" : ""}>
                    <header><b>{mode.id}</b><span>{mode.displayLabel}</span><i>{mode.controlPlanePolicy.replace(/_/g, " ")}</i></header>
                    <p>{mode.runsWithoutAsking}</p><small>{mode.controlPlaneReason}</small>
                  </article>
                ))}
              </div>
            </section>
          </div>
        )}

        {tab === "sources" && catalog && (
          <div className="cc-reference-stack">
            <section className="cc-wide-card">
              <span className="cc-eyebrow">OFFICIAL CURRENT-BEHAVIOR SOURCES</span><h2>DOCUMENTATION INDEX</h2>
              <div className="cc-source-list">
                {catalog.sources.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer"><b>{source.title}</b><span>{source.publisher} // {source.authority}</span><code>{source.url}</code></a>)}
              </div>
            </section>
            <section className="cc-wide-card cc-capture-card">
              <span className="cc-eyebrow">REQUESTED GITHUB CORPUS // SNAPSHOT {catalog.provenance.snapshotCommit.slice(0, 12)}</span>
              <h2>UNVERIFIED PROVENANCE MANIFEST</h2><p>{catalog.provenance.warning}</p>
              <p>{catalog.provenance.repositoryLicense} repository declaration. {catalog.provenance.licenseCaveat}</p>
              <a className="fui-chip" href={catalog.provenance.snapshotTreeUrl} target="_blank" rel="noreferrer">OPEN SNAPSHOT TREE</a>
              <div className="cc-document-list">
                {catalog.provenance.documents.map((document) => (
                  <a key={document.path} href={document.url} target="_blank" rel="noreferrer">
                    <b>{document.path}</b><span>{document.relevance}</span><p>{document.summary}</p><code>SHA {document.blobSha} // {document.characterCount.toLocaleString()} chars // {document.lineCount.toLocaleString()} lines</code>
                  </a>
                ))}
              </div>
            </section>
          </div>
        )}

        {tab !== "session" && !catalog && <div className="cc-empty"><b>{loading ? "LOADING CATALOG..." : "CATALOG UNAVAILABLE"}</b></div>}
      </div>
    </section>
  );
}
