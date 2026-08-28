import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const api = read("apps/web/src/api.ts");
const view = read("apps/web/src/science/ScienceView.tsx");
const adminQueue = read("apps/web/src/science/AdminActionQueue.tsx");
const rail = read("apps/web/src/science/ScienceRail.tsx");
const versions = read("apps/web/src/science/ArtifactVersionControl.tsx");
const configurator = read("apps/web/src/science/RunConfigurator.tsx");
const viewport = read("apps/web/src/science/ScienceViewport.tsx");
const manifest = read("apps/web/src/science/ManifestInspector.tsx");
const pipeline = read("apps/web/src/science/PipelineStrip.tsx");
const domainValidation = read("apps/web/src/science/DomainValidationPanel.tsx");
const profiles = read("apps/web/src/science/ComputeProfileManager.tsx");
const fui = read("apps/web/src/fui.css");
const ui = read("packages/ui/src/index.tsx");

let passed = 0;
function acceptance(name, condition) {
  assert.ok(condition, name);
  passed += 1;
  console.log("ok - " + name);
}

function section(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, "missing section start: " + start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, "missing section end: " + end);
  return source.slice(from, to);
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

const admissionRead = section(view, "const loadAdmission", "const refreshRun");
const admissionMutation = section(view, "const updateAdmission", "const queueAge");

acceptance(
  "typed client reads member projection and sends strict admin patch",
  api.includes("updatedAt: string | null;") &&
    count(api, '"/api/science/workspace-admission"') === 2 &&
    api.includes("updateWorkspaceAdmission: (input: { admitted: boolean; reason: string })") &&
    count(api, "admission: ScienceWorkspaceAdmission") === 2,
);

acceptance(
  "new work fails closed until persisted admission is confirmed",
  /const newWorkEnabled\s*=\s*props\.canBuild && admission\?\.admitted === true && !admissionBusy/.test(view) &&
    view.includes('admissionState === "blocked"') &&
    view.includes('"PILOT ADMISSION UNKNOWN"'),
);

acceptance(
  "admission reads defer during mutation and refresh on every authoritative trigger",
  view.includes("scienceApi.workspaceAdmission()") &&
    view.includes('window.addEventListener("focus", refreshAdmission)') &&
    view.includes('document.addEventListener("visibilitychange", refreshAdmission)') &&
    view.includes("}, 30_000);") &&
    view.includes("loadAdmission(false),") &&
    view.includes("error instanceof ApiError && error.status === 503") &&
    view.includes("const admissionReadRequest = useRef(0);") &&
    view.includes("const admissionMutationRequest = useRef(0);") &&
    view.includes("const admissionMutationPending = useRef(false);") &&
    admissionRead.indexOf("if (admissionMutationPending.current) return;") <
      admissionRead.indexOf("scienceApi.workspaceAdmission()") &&
    admissionRead.includes(
      "request !== admissionReadRequest.current || admissionMutationPending.current",
    ) &&
    admissionMutation.indexOf("admissionMutationPending.current = true;") <
      admissionMutation.indexOf("scienceApi.updateWorkspaceAdmission") &&
    admissionMutation.indexOf("admissionReadRequest.current++;") <
      admissionMutation.indexOf("scienceApi.updateWorkspaceAdmission") &&
    admissionMutation.indexOf("admissionMutationPending.current = false;") <
      admissionMutation.indexOf("setAdmissionBusy(false);") &&
    admissionMutation.indexOf("setAdmissionBusy(false);") <
      admissionMutation.lastIndexOf("loadAdmission(false)"),
);

acceptance(
  "member-visible FUI instrument exposes admitted, blocked, and unknown states",
  view.includes('"PILOT ADMITTED"') &&
    view.includes('"PILOT NOT ADMITTED"') &&
    view.includes('className="sci-admission-readout" role="status" aria-live="polite"') &&
    view.includes('admission?.updatedAt ?? undefined') &&
    fui.includes(".sci-admission.state-blocked") &&
    fui.includes("@media (prefers-reduced-motion: reduce)"),
);

acceptance(
  "admin admission changes require bounded reason and deliberate state-keyed hold",
  view.includes("const reason = admissionReason.trim();") &&
  section(view, "{props.isAdmin && (", "{admissionError && (").includes('className="sci-admission-control"') &&
    view.includes("maxLength={1000}") &&
    view.includes("scienceApi.updateWorkspaceAdmission({ admitted, reason })") &&
    view.includes('key={admission ? String(admission.admitted) : "unknown"}') &&
    view.includes("HOLD TO") &&
    view.includes("!admissionReason.trim()"),
);

const guardedHandlers = [
  ["const createStudy", "const ingest", "scienceApi.createStudy"],
  ["const ingest", "const uploadArtifactVersion", "scienceApi.createArtifact"],
  ["const uploadArtifactVersion", "const expireArtifactVersion", "scienceApi.beginUpload"],
  ["const submitRun", "const cancelRun", "scienceApi.createRun"],
  ["const reproduce", "const compareRun", "scienceApi.reproduce"],
  ["const createComputeProfile", "const updateComputeProfile", "scienceApi.createComputeProfile"],
  ["const updateComputeProfile", "const startRender", "scienceApi.updateComputeProfile"],
  ["const startRender", "const closeRender", "scienceApi.createRenderSession"],
];
acceptance(
  "every new-work handler guards before action dispatch and API mutation",
  guardedHandlers.every(([start, end, apiCall]) => {
    const body = section(view, start, end);
    const guard = body.indexOf("if (!allowNewWork()) return;");
    const dispatch = body.indexOf("doAction(");
    const mutation = body.indexOf(apiCall);
    return guard >= 0 && guard < dispatch && dispatch < mutation && count(body, "allowNewWork()") === 1;
  }),
);

const ingestBody = section(view, "const ingest", "const uploadArtifactVersion");
const versionUploadBody = section(view, "const uploadArtifactVersion", "const expireArtifactVersion");
acceptance(
  "accepted uploads converge without a second admission check",
  [ingestBody, versionUploadBody].every(
    (body) =>
      count(body, "allowNewWork()") === 1 &&
      body.indexOf("allowNewWork()") < body.indexOf("doAction(") &&
      body.includes("scienceApi.putUpload") &&
      body.includes("scienceApi.completeUpload"),
  ),
);

acceptance(
  "create upload run reproduce and render controls consume split capability",
  count(rail, "!props.newWorkEnabled") >= 2 &&
  count(view, "newWorkEnabled={newWorkEnabled}") === 6 &&
    versions.includes("!props.newWorkEnabled ||") &&
    configurator.includes("!props.newWorkEnabled ||") &&
    manifest.includes("!props.newWorkEnabled ||") &&
    viewport.includes("!props.newWorkEnabled ||"),
);

acceptance(
  "compute profile selection remains readable while mutations are fieldset-disabled",
  profiles.includes("<fieldset") &&
    profiles.includes('className="sci-profile-form-grid"') &&
    profiles.includes("disabled={!props.newWorkEnabled || props.busy}") &&
    profiles.includes('<option value="" disabled={!props.newWorkEnabled}>NEW PROFILE</option>') &&
    profiles.includes("<Chip tiny disabled={!props.newWorkEnabled}") &&
    profiles.includes("if (!props.newWorkEnabled) return;"),
);

const preservedSections = [
  section(view, "const expireArtifactVersion", "const submitRun"),
  section(view, "const cancelRun", "const reproduce"),
  section(view, "const compareRun", "const createComputeProfile"),
  section(view, "const closeRender", "const updateAdmission"),
];
const purgeControl = section(versions, "RETENTION PURGE / ADMIN", "UPLOAD NEW VERSION");
acceptance(
  "purge cancel comparison and render close remain outside admission gate",
  preservedSections.every((body) => !body.includes("allowNewWork")) &&
    !purgeControl.includes("newWorkEnabled") &&
    view.includes("<RunDossier") &&
    view.includes("onCancel={cancelRun}") &&
    view.includes("onCloseSession={closeRender}"),
);

const renewal = section(view, "if (!renderSession ||", "setUtcClock");
acceptance(
  "revocation closes active renderer before any renewal",
  renewal.includes("if (admission?.admitted !== true)") &&
    renewal.indexOf("if (admission?.admitted !== true)") <
      renewal.indexOf("scienceApi.renewRenderSession") &&
    renewal.includes("scienceApi.closeRenderSession") &&
    view.includes("[admission?.admitted, renderSession?.expiresAt"),
);

const completionTimer = section(ui, "timer.current = setTimeout", "}, ms);");
acceptance(
  "HoldButton cancels on disable and unmount with timeout-side stale guard",
  ui.includes("const disabledRef = useRef(Boolean(props.disabled));") &&
    ui.includes("disabledRef.current = Boolean(props.disabled);") &&
    completionTimer.includes("if (disabledRef.current)") &&
    /useEffect\(\(\) => \{\s*if \(props\.disabled\) cancel\(\);\s*\}, \[props\.disabled\]\);/.test(ui) &&
    ui.includes("useEffect(() => cancel, []);"),
);

assert.equal(passed, 12);
console.log("science fui workspace admission acceptance: 12/12 assertions passed.");
const dossier = read("apps/web/src/science/RunDossier.tsx");
const scienceUtils = read("apps/web/src/science/science-utils.ts");
const app = read("apps/web/src/App.tsx");
const nexus = read("apps/web/src/nexus/registry.tsx");
const uiStyles = read("packages/ui/styles.css");

function cssRule(source, selector) {
  const from = source.indexOf(selector);
  assert.notEqual(from, -1, "missing CSS selector: " + selector);
  const open = source.indexOf("{", from + selector.length);
  const close = source.indexOf("}", open + 1);
  assert.ok(open >= 0 && close > open, "malformed CSS selector: " + selector);
  return source.slice(open + 1, close);
}

function cssExactRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp("(?:^|\\n)\\s*" + escaped + "\\s*\\{([\\s\\S]*?)\\}"));
  assert.ok(match, "missing exact CSS selector: " + selector);
  return match[1];
}

function cssValue(rule, property) {
  const match = rule.match(new RegExp(property + "\\s*:\\s*([^;]+);"));
  assert.ok(match, "missing CSS property: " + property);
  return match[1].trim();
}

function cssLengthInRem(value) {
  const match = /^(\d*\.?\d+)(rem|px)$/.exec(value);
  assert.ok(match, "unsupported CSS length: " + value);
  return match[2] === "rem" ? Number(match[1]) : Number(match[1]) / 16;
}

function hexRgb(value) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  assert.ok(match, "expected six-digit hex color: " + value);
  return match.slice(1).map((channel) => Number.parseInt(channel, 16) / 255);
}

function relativeLuminance(value) {
  const channels = hexRgb(value).map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

passed = 0;
const scienceCss = section(fui, "/* ---- SCIENCE OPERATIONS", "/* ---- Login");
const scienceRoot = cssRule(scienceCss, ".science-ops");
const rootTokens = cssRule(uiStyles, ":root");
const criticalRem = cssLengthInRem(cssValue(scienceRoot, "--sci-font-critical"));
const secondaryRem = cssLengthInRem(cssValue(scienceRoot, "--sci-font-secondary"));
const watchRail = cssRule(fui, ".watch-rail");
const watchLabel = cssRule(fui, ".watch-label");
const watchScope = cssRule(fui, ".watch-scope");
const visibleShellTypeSelectors = [
  ".brand-sub",
  ".tag-lo",
  ".status",
  ".vs",
  ".vs .vs-idx",
  ".stage-hint",
  ".signal-rail",
  ".sig-label",
  ".sig-entry .sig-t",
  ".sig-clock .utc",
  ".user-chip",
];
const explicitScienceFontPixels = [...scienceCss.matchAll(/\bfont(?:-size)?\s*:\s*([^;]+);/g)]
  .flatMap((declaration) =>
    [...declaration[1].matchAll(/(\d*\.?\d+)(rem|px)\b/g)].map((length) =>
      length[2] === "rem" ? Number(length[1]) * 16 : Number(length[1]),
    ),
  );

acceptance(
  "Science typography tokens enforce a 12px floor including scoped shared controls",
  criticalRem >= 0.75 &&
    secondaryRem >= 0.75 &&
    criticalRem >= secondaryRem &&
    explicitScienceFontPixels.every((pixels) => pixels >= 12) &&
    scienceCss.includes(".science-ops .fui-chip.tiny,") &&
    scienceCss.includes(".science-ops .fui-hold.tiny,") &&
    scienceCss.includes(".science-ops .fui-stat-label {") &&
    cssValue(cssRule(scienceCss, ".science-ops .fui-chip.tiny,"), "font-size") ===
      "var(--sci-font-critical)" &&
    cssValue(cssRule(scienceCss, ".science-ops .fui-stat-unit"), "font-size") ===
      "var(--sci-font-secondary)" &&
    uiStyles.includes(".fui-chip.tiny") &&
    uiStyles.includes(".fui-hold.tiny") &&
    cssLengthInRem(cssValue(watchRail, "font-size")) >= 0.75 &&
    cssLengthInRem(cssValue(watchLabel, "font-size")) >= 0.75 &&
    cssLengthInRem(cssValue(watchScope, "font-size")) >= 0.75 &&
    visibleShellTypeSelectors.every(
      (selector) => cssLengthInRem(cssValue(cssExactRule(fui, selector), "font-size")) >= 0.75,
    ) &&
    count(scienceCss, "var(--sci-font-critical)") > 10 &&
    count(scienceCss, "var(--sci-font-secondary)") > 10,
);

const textLo = cssValue(rootTokens, "--text-lo");
const panel = cssValue(rootTokens, "--panel");
const admissionBackground = cssValue(cssRule(scienceCss, ".sci-admission"), "background");
acceptance(
  "audited admission time and pipeline index colors compute above 4.5 to 1",
  cssValue(cssRule(scienceCss, ".sci-admission-readout time"), "color") === "var(--text-lo)" &&
    cssValue(cssRule(scienceCss, ".sci-pipeline-index"), "color") === "var(--text-lo)" &&
    cssValue(cssRule(fui, ".wr.dim-part"), "color") === "var(--text-lo)" &&
    cssValue(watchScope, "color") === "var(--text-lo)" &&
    cssValue(cssExactRule(fui, ".vs .vs-idx"), "color") === "var(--text-lo)" &&
    cssValue(cssExactRule(fui, ".sig-entry .sig-t"), "color") === "var(--text-lo)" &&
    cssValue(cssExactRule(fui, ".sig-idle"), "color") === "var(--text-lo)" &&
    cssValue(cssExactRule(fui, ".sig-clock .utc"), "color") === "var(--text-lo)" &&
    contrastRatio(textLo, admissionBackground) >= 4.5 &&
    contrastRatio(textLo, panel) >= 4.5 &&
    contrastRatio(textLo, "#070708") >= 4.5,
);

const broadLayout = section(scienceCss, "@media (max-width: 1180px)", "@media (max-width: 760px)");
const narrowLayout = section(
  scienceCss,
  "@media (max-width: 760px)",
  "@media (prefers-reduced-motion: reduce)",
);
const beforeNarrowLayout = scienceCss.slice(0, scienceCss.indexOf("@media (max-width: 760px)"));
const scienceWorkspace = cssRule(scienceCss, ".sci-workspace");
acceptance(
  "analytical pixels remain isolated, desktop controls stay scroll-reachable, and the narrow shell is bounded",
  cssRule(fui, "body::before").includes("z-index: 90") &&
    cssRule(fui, "body::after").includes("z-index: 91") &&
    cssRule(scienceCss, ".sci-viewport-isolation").includes("z-index: 92") &&
    cssRule(scienceCss, ".sci-viewport-isolation").includes("isolation: isolate") &&
    cssRule(scienceCss, ".sci-viewport-isolation").includes("background: #050608") &&
    cssValue(scienceRoot, "overflow-x") === "hidden" &&
    cssValue(scienceRoot, "overflow-y") === "auto" &&
    cssValue(scienceWorkspace, "flex") === "1 0 360px" &&
    cssValue(scienceWorkspace, "min-height") === "360px" &&
    broadLayout.includes("overflow-x: hidden") &&
    narrowLayout.includes(".sci-admission-control { grid-template-columns: 1fr; }") &&
    narrowLayout.includes(".sci-admission-readout time { justify-self: start; }") &&
    narrowLayout.includes(".app-view-science .rail {") &&
    narrowLayout.includes(".app-view-science .view-switch {") &&
    narrowLayout.includes(".app-view-science .rail-meta .fui-chip.tiny { min-height: 24px; }") &&
    narrowLayout.includes(".sci-stat-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }") &&
    scienceCss.includes(".sci-stat-row > * { min-width: 0; }") &&
    !beforeNarrowLayout.includes(".sci-admission-control { grid-template-columns: 1fr; }"),
);

const reducedMotionCss = scienceCss.slice(
  scienceCss.indexOf("@media (prefers-reduced-motion: reduce)"),
);
acceptance(
  "reduced-motion preference reacts at runtime and suppresses Science transitions",
  scienceUtils.includes('window.matchMedia?.("(prefers-reduced-motion: reduce)")') &&
    scienceUtils.includes('media.addEventListener?.("change", change)') &&
    scienceUtils.includes('media.removeEventListener?.("change", change)') &&
    view.includes("const reducedMotion = usePrefersReducedMotion();") &&
    view.includes('reducedMotion ? "reduced-motion" : ""') &&
    reducedMotionCss.includes(".science-ops *::before") &&
    reducedMotionCss.includes("animation-duration: 0.001ms !important") &&
    reducedMotionCss.includes("transition-duration: 0.001ms !important"),
);

acceptance(
  "virtual lists tabs and hold confirmations retain keyboard contracts",
  rail.includes('role="listbox"') &&
    rail.includes("aria-activedescendant={activeDescendant}") &&
    ["ArrowDown", "ArrowUp", "Home", "End"].every((key) => rail.includes('event.key === "' + key + '"')) &&
    rail.includes("event.preventDefault();") &&
    dossier.includes('role="tablist"') &&
    dossier.includes('role="tab"') &&
    dossier.includes('role="tabpanel"') &&
    ["ArrowRight", "ArrowLeft", "Home", "End"].every((key) =>
      dossier.includes('event.key === "' + key + '"'),
    ) &&
    dossier.includes("requestAnimationFrame(() => document.getElementById") &&
    dossier.includes('<ol tabIndex={0} aria-label="Scrollable recent run events">') &&
    ui.includes('e.key === "Enter" || e.key === " "') &&
    ui.includes("!e.repeat") &&
    ui.includes('role="progressbar"') &&
    ui.includes('aria-live="polite"'),
);

const inlineMediaTypes = section(
  viewport,
  "const INLINE_STATIC_MEDIA_TYPES",
  "function metadataRows",
);
const sameOriginRenderer = section(
  viewport,
  "function sameOriginRenderUrl",
  "type GeometryWorkerResponse",
);
acceptance(
  "fallback viewport admits only supported inline images and retains safe alternatives",
  ["image/png", "image/jpeg", "image/gif", "image/webp"].every((type) =>
    inlineMediaTypes.includes('"' + type + '"'),
  ) &&
    count(inlineMediaTypes, '"image/') === 4 &&
    viewport.includes("const image = INLINE_STATIC_MEDIA_TYPES.has(mediaType);") &&
    viewport.includes("attachment-only and is not admitted for inline preview") &&
    viewport.includes('<option value="static">STATIC IMAGE</option>') &&
    viewport.includes('<option value="table">STRUCTURED TABLE</option>') &&
    viewport.includes("<caption>Structured non-WebGL artifact and run summary</caption>") &&
    viewport.includes('aria-label="Scrollable structured artifact and run summary"') &&
    viewport.includes("tabIndex={0}") &&
    viewport.includes("STATIC PREVIEW FAILED") &&
    viewport.includes("props.onModeChange(\"table\")") &&
    sameOriginRenderer.includes("url.origin === globalThis.location.origin") &&
    viewport.includes('sandbox="allow-scripts allow-forms allow-pointer-lock"') &&
    viewport.includes('referrerPolicy="no-referrer"'),
);

const startRenderBody = section(view, "const startRender", "const closeRender");
const closeRenderBody = section(view, "const closeRender", "const updateAdmission");
acceptance(
  "static render preserves exact source, request replay, and close replay identity",
  view.includes('output.mediaType?.trim().toLowerCase() === "image/png"') &&
    view.includes('/^[0-9a-f]{64}$/i.test(output.sha256 ?? "")') &&
    view.includes("SCIENCE_STATIC_RENDER_MAX_BYTES") &&
    startRenderBody.includes("eligibleRenderOutputs.find") &&
    startRenderBody.includes("pendingRenderRequest.current") &&
    startRenderBody.includes("idempotencyKey: request.idempotencyKey") &&
    startRenderBody.includes('mode: "static"') &&
    startRenderBody.includes("error.status === 409") &&
    startRenderBody.includes("idempotency key.*different request intent") &&
    !startRenderBody.includes("inspectedArtifact") &&
    closeRenderBody.includes("await scienceApi.closeRenderSession(session.id)") &&
    closeRenderBody.indexOf("await scienceApi.closeRenderSession(session.id)") <
      closeRenderBody.indexOf("setRenderSession(null)") &&
    viewport.includes('aria-label="Exact ready PNG render output"') &&
    viewport.includes("SHA {shortHash(output.sha256)}") &&
    viewport.includes("!props.newWorkEnabled || props.busy || !hasRenderableOutput") &&
    viewport.includes("staticSessionReady && renderUrl && props.session") &&
    viewport.includes("src={renderUrl}") &&
    viewport.includes('props.session?.mode === "remote" && renderUrl') &&
    viewport.includes("props.session.source.sha256") &&
    viewport.includes("No ready PNG output within the inline size cap"),
);

const uploadCopy = scienceUtils + "\n" + rail + "\n" + versions;
const scienceErrorBody = section(scienceUtils, "export function scienceError", "export function fmtBytes");
acceptance(
  "large-file guidance and 404 errors preserve truthful operator-facing distinctions",
  !uploadCopy.includes("server/S3 ingest path") &&
    count(uploadCopy, "documented streaming REST upload contract") >= 3 &&
    /return !detail \|\| detail\.toLowerCase\(\) === "not found"\s*\? "Science service is not installed on this server\."\s*: detail;/.test(
      scienceErrorBody,
    ),
);

acceptance(
  "Science reaches authorizations and restores authoritative run dossiers after reconnect",
  app.includes('const stageSolo = view === "nexus" || view === "science";') &&
    app.includes("for (const t of TASKS.filter") &&
    app.includes('group: "TASKS"') &&
    app.includes('setView("nexus");') &&
    app.includes("setNexusSpawn({ task: t.id") &&
    nexus.includes("function AuthorizationsBody") &&
    nexus.includes('{ id: "authorizations"') &&
    nexus.includes('title: "AUTHORIZATIONS"') &&
    view.includes("runDetail?.id === selectedRunId") &&
    view.includes("selectedRunId ? refreshRun(selectedRunId) : Promise.resolve(null)"),
);

const compareClient = section(api, "compareRuns:", "domainValidations:");
const domainValidationClient = section(api, "domainValidations:", "createRenderSession:");

const reproduceHandler = section(view, "const reproduce", "const compareRun");
assert.ok(
  api.includes("export interface ScienceManifestResult") &&
    api.includes('if ("manifest" in body)') &&
    view.includes("useState<ScienceManifestResult | null>(null)") &&
    view.includes("manifest={manifestResult?.manifest ?? null}") &&
    view.includes("complete: manifestResult.complete, gaps: manifestResult.gaps") &&
    reproduceHandler.indexOf("if (!manifestResult?.complete)") <
      reproduceHandler.indexOf("scienceApi.reproduce") &&
    manifest.includes('assessment: Pick<ScienceManifestResult, "complete" | "gaps"> | null;') &&
    manifest.includes("assessment.gaps.map") &&
    manifest.includes("!assessment.complete") &&
    manifest.includes("SHA identifies immutable server-held manifest bytes") &&
    !manifest.includes("manifest.complete") &&
    pipeline.includes('Pick<ScienceManifestResult, "complete" | "gaps">') &&
    pipeline.includes("assessment?.complete") &&
    !pipeline.includes("ScienceManifest,"),
  "stored manifest bytes stay separate while every FUI operational verdict uses the current server assessment",
);

assert.ok(
  api.includes("export interface ScienceDomainValidationSummary") &&
    api.includes("export interface ScienceDomainValidationDetail") &&
    domainValidationClient.includes("domainValidations:") &&
    domainValidationClient.includes(".then(sciencePage<ScienceDomainValidationSummary>)") &&
    domainValidationClient.includes("domainValidation: (runId: string, validationId: string)") &&
    domainValidationClient.includes('scienceEntity<ScienceDomainValidationDetail>(res, "validation")') &&
    domainValidationClient.includes("createDomainValidation: (runId: string, input: ScienceDomainValidationInput)") &&
    domainValidationClient.includes("post(`/api/science/runs/${encodeURIComponent(runId)}/validations`, input)"),
  "domain-validation client keeps bounded list, scoped detail, and append contracts distinct",
);

const validationSubmit = section(domainValidation, "const submit = async () =>", "const previousPage");
assert.ok(
  domainValidation.includes("const VALIDATION_PAGE_SIZE = 10;") &&
    domainValidation.includes("scienceApi.domainValidations(props.runId") &&
    domainValidation.includes("scienceApi.domainValidation(props.runId, selectedId)") &&
    domainValidation.includes('aria-label="Append-only validation revisions"') &&
    domainValidation.includes("aria-pressed={item.id === selectedId}") &&
    domainValidation.includes("PREVIOUS RECORDS") &&
    domainValidation.includes("NEXT RECORDS") &&
    domainValidation.includes('<ValidationChecksums label="CANDIDATE OUTPUTS"') &&
    domainValidation.includes('<ValidationChecksums label="BASELINE OUTPUTS"') &&
    domainValidation.includes("recordHash") &&
    domainValidation.includes("runManifestHash"),
  "members receive paginated immutable summaries and checksum-bound detail",
);

assert.ok(
  domainValidation.includes("{props.isAdmin && (") &&
    domainValidation.includes("Reviewer ID and role come from the signed-in session.") &&
    domainValidation.includes("SYNTHETIC / NON-RELEASE") &&
    domainValidation.includes("maxLength={200}") &&
    domainValidation.includes("maxLength={100}") &&
    domainValidation.includes("maxLength={300}") &&
    domainValidation.includes("maxLength={2_000}") &&
    domainValidation.includes('kind === "numerical-equivalence" ? { baselineRunId } : {}') &&
    domainValidation.includes('kind === "domain-validation" || baselineCandidates.some') &&
    validationSubmit.includes("if (!props.isAdmin || !formValid || submitting") &&
    validationSubmit.includes("scienceApi.createDomainValidation(submissionRunId, input)") &&
    !validationSubmit.includes("reviewerId") &&
    !validationSubmit.includes("reviewerRole") &&
    !domainValidation.includes("newWorkEnabled") &&
    domainValidation.includes("<HoldButton") &&
    domainValidation.includes('title="Hold to append an immutable, session-attributed validation revision"') &&
    manifest.includes("<DomainValidationPanel") &&
    manifest.includes("props.runState === \"succeeded\"") &&
    view.includes("isAdmin={props.isAdmin}") &&
    view.includes("runState={selectedRun?.state ?? null}"),
  "admin or owner authoring is deliberate, session-attributed, bounded, and independent of pilot admission",
);

assert.ok(
  cssValue(cssRule(scienceCss, ".sci-validation-list button"), "font")
    .includes("var(--sci-font-critical)") &&
    cssValue(cssRule(scienceCss, ".sci-validation-list button"), "min-height") === "3rem" &&
    cssValue(cssRule(scienceCss, ".sci-validation-list button > small,"), "font-size") ===
      "var(--sci-font-secondary)" &&
    cssValue(cssRule(scienceCss, ".sci-validation-decision label"), "font-size") ===
      "var(--sci-font-critical)" &&
    scienceCss.includes(".sci-validation-list button:focus-visible") &&
    scienceCss.includes(".sci-validation-checksums > ul:focus-visible"),
  "validation ledger preserves the Science type floor and visible keyboard focus",
);

acceptance(
  "admin action queue is admin-only, redacted, bounded, and navigates typed internal context",
  api.includes("/api/science/admin/action-queue") &&
    compareClient.includes("fetch(") &&
    compareClient.includes("?candidateRunId=${encodeURIComponent(candidateRunId)}") &&
    !compareClient.includes("post(") &&
    view.includes("{props.isAdmin && (") &&
    view.includes("<AdminActionQueue onNavigate={navigateAdminAction} />") &&
    view.includes("function adminLinkEntityId") &&
    view.includes("Science administrator action returned duplicate typed links.") &&
    view.includes("for (let pageNumber = 0; pageNumber < 25; pageNumber++)") &&
    adminQueue.includes("const ADMIN_QUEUE_REFRESH_MS = 30_000;") &&
    adminQueue.includes("if (!document.hidden) void load(cursor);") &&
    adminQueue.includes("NO ADMIN ACTIONS REQUIRE ATTENTION.") &&
    adminQueue.includes("Exact redacted reason code") &&
    adminQueue.includes('<time dateTime={value} title={value}>') &&
    adminQueue.includes('key={`${item.kind}:${item.id}`}') &&
    !adminQueue.includes("<a ") &&
    cssValue(cssRule(scienceCss, ".sci-admin-action-queue"), "max-height") === "190px" &&
    cssValue(cssRule(scienceCss, ".sci-admin-action-queue"), "overflow") === "hidden" &&
    cssValue(cssRule(scienceCss, ".sci-admin-queue-list"), "overflow-y") === "auto",
);

assert.equal(passed, 10);
console.log("science fui local release acceptance: 10/10 assertions passed.");
console.log(
  "external gate - retain a Playwright + axe real-browser keyboard/contrast journey before release.",
);
