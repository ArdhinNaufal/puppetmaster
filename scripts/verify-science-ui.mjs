import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const api = read("apps/web/src/api.ts");
const view = read("apps/web/src/science/ScienceView.tsx");
const rail = read("apps/web/src/science/ScienceRail.tsx");
const versions = read("apps/web/src/science/ArtifactVersionControl.tsx");
const configurator = read("apps/web/src/science/RunConfigurator.tsx");
const viewport = read("apps/web/src/science/ScienceViewport.tsx");
const manifest = read("apps/web/src/science/ManifestInspector.tsx");
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
