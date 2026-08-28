#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  InMemoryEventBus,
  WorkflowExecutor,
  lintWorkflowGraph,
  resolveApprovalPrompt,
  resolveWorkflowActionArgs,
  runCodeNode,
} from "../packages/kernel/dist/index.js";
import {
  createDb,
  createMission,
  createWorkflow,
  ensureDefaultWorkspace,
  findApprovalForNode,
  getMission,
  migrate,
} from "../packages/db/dist/index.js";
import { WorkflowGraph } from "../packages/shared/dist/index.js";
import { BUILTIN_TEMPLATES } from "../apps/server/dist/seeds.js";

const ids = {
  study: "00000000-0000-4000-8000-000000000101",
  profile: "00000000-0000-4000-8000-000000000102",
  artifact: "00000000-0000-4000-8000-000000000103",
  version: "00000000-0000-4000-8000-000000000104",
  run: "00000000-0000-4000-8000-000000000105",
  outputVersion: "00000000-0000-4000-8000-000000000106",
  alternateOutputVersion: "00000000-0000-4000-8000-000000000107",
  renderSession: "00000000-0000-4000-8000-000000000108",
};
const sha256 = "a".repeat(64);
const outputSha256 = "b".repeat(64);
const manifestSha256 = "c".repeat(64);
// Exact released ScienceService static-render admission ceiling.
const MAX_STATIC_BYTES = 8 * 1024 * 1024;
assert.equal(MAX_STATIC_BYTES, 8_388_608);
const resourceRequest = {
  cpuMillicores: 500,
  memoryMb: 512,
  gpuCount: 0,
  wallTimeSeconds: 60,
};
const inputs = [{ artifactVersionId: ids.version, semanticRole: "notebook" }];

const stepOutputs = {
  t1: {
    studyId: ids.study,
    computeProfileId: ids.profile,
    resourceRequest,
    inputs,
    parameters: { boundaryTemperatureK: 300 },
    idempotencyKey: "workflow-proof-1",
  },
  quote: {
    available: true,
    source: "declared",
    limits: resourceRequest,
  },
};

const resolved = resolveWorkflowActionArgs(
  {
    studyId: "{{steps.t1.studyId}}",
    nested: {
      request: "{{steps.t1.resourceRequest}}",
      firstInput: "{{steps.t1.inputs.0}}",
    },
    list: ["{{steps.t1.inputs.0.artifactVersionId}}"],
    immediate: "{{input.value}}",
    optionalLegacyInput: "{{input.omitted}}",
    literal: "prefix {{steps.t1.studyId}}",
  },
  { value: 7 },
  stepOutputs,
);
assert.equal(resolved.studyId, ids.study);
assert.deepEqual(resolved.nested.request, resourceRequest);
assert.notEqual(
  resolved.nested.request,
  resourceRequest,
  "resolved objects must be cloned so a tool cannot mutate the durable cursor",
);
assert.deepEqual(resolved.nested.firstInput, inputs[0]);
assert.deepEqual(resolved.list, [ids.version]);
assert.equal(resolved.immediate, 7);
assert.equal(resolved.optionalLegacyInput, undefined);
assert.equal(resolved.literal, "prefix {{steps.t1.studyId}}");

await assert.rejects(
  async () => resolveWorkflowActionArgs({ value: "{{steps.missing.id}}" }, null, stepOutputs),
  /not a completed prior step/,
);
await assert.rejects(
  async () => resolveWorkflowActionArgs({ value: "{{steps.t1.missing}}" }, null, stepOutputs),
  /does not exist/,
);
await assert.rejects(
  async () => resolveWorkflowActionArgs({ value: "{{steps.t1.__proto__}}" }, null, stepOutputs),
  /forbidden path segment/,
);
await assert.rejects(
  async () => resolveWorkflowActionArgs({ value: "{{steps.bad.id.with.dot.value}}" }, null, stepOutputs),
  /not a completed prior step/,
);

let getterInvoked = false;
const accessorArgs = {};
Object.defineProperty(accessorArgs, "unsafe", {
  enumerable: true,
  get() {
    getterInvoked = true;
    return "must-not-run";
  },
});
await assert.rejects(
  async () => resolveWorkflowActionArgs(accessorArgs, null, stepOutputs),
  /must not contain accessors/,
);
assert.equal(getterInvoked, false, "argument resolution invoked an accessor");
await assert.rejects(
  async () => resolveWorkflowActionArgs(
    JSON.parse('{"__proto__":{"polluted":true}}'),
    null,
    stepOutputs,
  ),
  /forbidden object key/,
);
const cyclic = {};
cyclic.self = cyclic;
await assert.rejects(
  async () => resolveWorkflowActionArgs(cyclic, null, stepOutputs),
  /contain a cycle/,
);

const scienceTemplate = BUILTIN_TEMPLATES.find(
  (template) => template.kind === "workflow" &&
    template.name === "Science: reproducible notebook run",
);
assert.ok(scienceTemplate, "Science builtin workflow template is missing");
const graph = WorkflowGraph.parse(scienceTemplate.spec);
assert.deepEqual(
  lintWorkflowGraph(graph).filter((issue) => issue.severity === "error"),
  [],
  "Science builtin workflow must remain a valid DAG",
);
const byId = new Map(graph.nodes.map((node) => [node.id, node]));
const reviewNode = byId.get("review_evidence");
const submitNode = byId.get("science__run.submit");
const statusNode = byId.get("science__run.status");
const selectRenderNode = byId.get("select_static_render_source");
const authorizeRenderNode = byId.get("authorize_static_render");
const renderNode = byId.get("science__render.open");
const manifestNode = byId.get("science__manifest.read");
const finalizeNode = byId.get("finalize_static_result");
assert.equal(reviewNode?.kind, "code");
assert.equal(submitNode?.kind, "action");
assert.equal(statusNode?.kind, "action");
assert.equal(selectRenderNode?.kind, "code");
assert.equal(authorizeRenderNode?.kind, "approval");
assert.equal(renderNode?.kind, "action");
assert.equal(manifestNode?.kind, "action");
assert.equal(finalizeNode?.kind, "code");
assert.doesNotMatch(
  selectRenderNode.config.source,
  /run\.manifest\?\.complete/,
  "render selection must not trust the immutable manifest's historical completeness bit",
);
assert.doesNotMatch(
  finalizeNode.config.source,
  /provenance\.manifest\?\.complete/,
  "finalization must use the manifest service's current top-level assessment",
);
assert.deepEqual(statusNode?.config.defer, { kind: "science_run_terminal" });
assert.equal(statusNode?.config.server, "science");
assert.equal(statusNode?.config.tool, "run.status");
assert.equal(authorizeRenderNode?.config.prompt, "{{input.approvalPrompt}}");
assert.equal(renderNode?.config.server, "science");
assert.equal(renderNode?.config.tool, "render.open");
assert.deepEqual(renderNode?.config.args, {
  runId: "{{steps.authorize_static_render.runId}}",
  artifactVersionId: "{{steps.authorize_static_render.artifactVersionId}}",
  mode: "static",
  idempotencyKey: "{{steps.authorize_static_render.renderIdempotencyKey}}",
});
assert.equal(manifestNode?.config.server, "science");
assert.equal(manifestNode?.config.tool, "manifest.read");
assert.deepEqual(manifestNode?.config.args, {
  runId: "{{steps.select_static_render_source.runId}}",
});
assert.ok(
  Object.values(submitNode.config.args).every(
    (value) => typeof value === "string" && /^\{\{steps\.review_evidence\./.test(value),
  ),
  "submission must consume the exact human-reviewed evidence record",
);
for (const requiredEdge of [
  ["science__artifact.inspect", "review_evidence"],
  ["science__run.quote", "review_evidence"],
  ["review_evidence", "authorize"],
  ["authorize", "science__run.submit"],
  ["science__run.submit", "science__run.status"],
  ["science__run.status", "select_static_render_source"],
  ["select_static_render_source", "authorize_static_render"],
  ["select_static_render_source", "science__manifest.read"],
  ["authorize_static_render", "science__render.open"],
  ["science__render.open", "finalize_static_result"],
  ["science__manifest.read", "finalize_static_result"],
]) {
  assert.ok(
    graph.edges.some((edge) => edge.from === requiredEdge[0] && edge.to === requiredEdge[1]),
    `Science builtin is missing edge ${requiredEdge[0]} -> ${requiredEdge[1]}`,
  );
}
assert.deepEqual(
  graph.edges.filter((edge) => edge.to === "science__render.open").map((edge) => edge.from),
  ["authorize_static_render"],
  "static render must have no path that bypasses its exact-source approval",
);
assert.deepEqual(
  graph.edges.filter((edge) => edge.from === "science__run.status").map((edge) => edge.to),
  ["select_static_render_source"],
  "terminal status must pass through fail-closed source selection before rendering",
);

const reviewContext = {
  t1: stepOutputs.t1,
  "science__artifact.inspect": {
    artifact: { id: ids.artifact, logicalName: "pilot.ipynb" },
    versions: {
      items: [{
        id: ids.version,
        status: "ready",
        sha256,
        size: 1024,
        mediaType: "application/x-ipynb+json",
      }],
    },
  },
  "science__run.quote": stepOutputs.quote,
};
const review = await runCodeNode(reviewNode.config.source, reviewContext, null, 2_000);
assert.equal(review.inspectedArtifact.sha256, sha256);
assert.deepEqual(review.resourceRequest, resourceRequest);
assert.deepEqual(review.inputs, inputs);
assert.equal(review.quote.available, true);
assert.equal("storageKey" in review.inspectedArtifact, false);

await assert.rejects(
  runCodeNode(
    reviewNode.config.source,
    {
      ...reviewContext,
      "science__run.quote": { ...stepOutputs.quote, available: false, reason: "offline" },
    },
    null,
    2_000,
  ),
  /compute quote unavailable: offline/,
);
await assert.rejects(
  runCodeNode(
    reviewNode.config.source,
    {
      ...reviewContext,
      t1: {
        ...stepOutputs.t1,
        inputs: [{
          artifactVersionId: "00000000-0000-4000-8000-000000000199",
          semanticRole: "notebook",
        }],
      },
    },
    null,
    2_000,
  ),
  /do not include an inspected ready artifact version/,
);

const pngOutput = (overrides = {}) => {
  const versionOverrides = overrides.version ?? {};
  const artifactVersionId = overrides.artifactVersionId ??
    versionOverrides.id ??
    ids.outputVersion;
  return {
    id: "00000000-0000-4000-8000-000000000109",
    runId: ids.run,
    artifactVersionId,
    direction: "output",
    semanticRole: "plot",
    createdAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
    version: {
      id: artifactVersionId,
      status: "ready",
      sha256: outputSha256,
      sizeBytes: 4096,
      mediaType: "image/png",
      ...versionOverrides,
    },
  };
};

const renderSelectionContext = ({
  run = {},
  manifestAssessment = {},
  outputs = [pngOutput()],
  reviewedRunKey = stepOutputs.t1.idempotencyKey,
} = {}) => ({
  review_evidence: {
    ...review,
    idempotencyKey: reviewedRunKey,
  },
  "science__run.status": {
    run: {
      id: ids.run,
      state: "succeeded",
      manifest: { complete: true },
      manifestHash: manifestSha256,
      ...run,
    },
    manifestAssessment: {
      complete: true,
      gaps: [],
      manifestHash: manifestSha256,
      ...manifestAssessment,
    },
    outputs,
  },
});

const selectedSource = await runCodeNode(
  selectRenderNode.config.source,
  renderSelectionContext(),
  null,
  2_000,
);
assert.deepEqual(
  {
    runId: selectedSource.runId,
    artifactVersionId: selectedSource.artifactVersionId,
    mediaType: selectedSource.mediaType,
    sha256: selectedSource.sha256,
    sizeBytes: selectedSource.sizeBytes,
    semanticRole: selectedSource.semanticRole,
    maxStaticBytes: selectedSource.maxStaticBytes,
    manifestHash: selectedSource.manifestHash,
  },
  {
    runId: ids.run,
    artifactVersionId: ids.outputVersion,
    mediaType: "image/png",
    sha256: outputSha256,
    sizeBytes: 4096,
    semanticRole: "plot",
    maxStaticBytes: MAX_STATIC_BYTES,
    manifestHash: manifestSha256,
  },
);
assert.match(
  selectedSource.renderIdempotencyKey,
  new RegExp(
    `^science-static-v1-[0-9a-f]{16}-${ids.run}-${ids.outputVersion}$`,
  ),
);
assert.ok(selectedSource.renderIdempotencyKey.length <= 200);
assert.match(selectedSource.runKeyFingerprint, /^[0-9a-f]{16}$/);
const expectedApprovalPrompt =
  `Approve same-origin static render of run ${ids.run}; artifact ${ids.outputVersion}; ` +
  `media image/png; SHA-256 ${outputSha256}; size 4096 bytes (maximum ${MAX_STATIC_BYTES}). ` +
  "This does not authorize remote or Trame rendering.";
assert.equal(selectedSource.approvalPrompt, expectedApprovalPrompt);
assert.ok(selectedSource.approvalPrompt.length <= 500);
assert.equal(
  resolveApprovalPrompt("{{input.approvalPrompt}}", selectedSource),
  expectedApprovalPrompt,
  "the approval engine must resolve the exact bounded source prompt shown to the reviewer",
);
assert.equal(
  resolveApprovalPrompt("Keep this static prompt byte-for-byte.", null),
  "Keep this static prompt byte-for-byte.",
  "legacy static approval prompts must remain unchanged",
);
assert.throws(
  () => resolveApprovalPrompt("Approve {{input.approvalPrompt}}", selectedSource),
  /must be exactly \{\{input\.approvalPrompt\}\}/,
);
assert.throws(
  () => resolveApprovalPrompt("{{input.other}}", { other: expectedApprovalPrompt }),
  /must be exactly \{\{input\.approvalPrompt\}\}/,
);
for (const invalidPrompt of [
  null,
  { text: expectedApprovalPrompt },
  "",
  "   ",
]) {
  assert.throws(
    () => resolveApprovalPrompt("{{input.approvalPrompt}}", { approvalPrompt: invalidPrompt }),
    /nonempty plain string/,
  );
}
assert.throws(
  () => resolveApprovalPrompt(
    "{{input.approvalPrompt}}",
    { approvalPrompt: "x".repeat(1_025) },
  ),
  /exceeds 1024 characters/,
);
assert.throws(
  () => resolveApprovalPrompt(
    "{{input.approvalPrompt}}",
    { approvalPrompt: "\u20ac".repeat(700) },
  ),
  /exceeds 2048 UTF-8 bytes/,
);
assert.throws(
  () => resolveApprovalPrompt(
    "{{input.approvalPrompt}}",
    { approvalPrompt: `${expectedApprovalPrompt}\nspoofed second line` },
  ),
  /forbidden control characters/,
);
let approvalPromptGetterInvoked = false;
const accessorPromptInput = {};
Object.defineProperty(accessorPromptInput, "approvalPrompt", {
  enumerable: true,
  get() {
    approvalPromptGetterInvoked = true;
    return expectedApprovalPrompt;
  },
});
assert.throws(
  () => resolveApprovalPrompt("{{input.approvalPrompt}}", accessorPromptInput),
  /nonempty plain string/,
);
assert.equal(approvalPromptGetterInvoked, false, "approval prompt resolution invoked an accessor");
const repeatedSelection = await runCodeNode(
  selectRenderNode.config.source,
  renderSelectionContext(),
  null,
  2_000,
);
assert.equal(
  repeatedSelection.renderIdempotencyKey,
  selectedSource.renderIdempotencyKey,
  "the reviewed run key must derive the same render idempotency key on replay",
);
const changedRunKeySelection = await runCodeNode(
  selectRenderNode.config.source,
  renderSelectionContext({ reviewedRunKey: "workflow-proof-2" }),
  null,
  2_000,
);
assert.notEqual(
  changedRunKeySelection.renderIdempotencyKey,
  selectedSource.renderIdempotencyKey,
  "changing the reviewed run key must change the render idempotency key",
);
const deterministicSelection = await runCodeNode(
  selectRenderNode.config.source,
  renderSelectionContext({
    outputs: [
      pngOutput({
        artifactVersionId: ids.alternateOutputVersion,
        version: { id: ids.alternateOutputVersion },
      }),
      pngOutput(),
    ],
  }),
  null,
  2_000,
);
assert.equal(
  deterministicSelection.artifactVersionId,
  ids.outputVersion,
  "multiple valid PNGs must use stable artifact-version ordering",
);
const ceilingSelection = await runCodeNode(
  selectRenderNode.config.source,
  renderSelectionContext({
    outputs: [pngOutput({ version: { sizeBytes: MAX_STATIC_BYTES } })],
  }),
  null,
  2_000,
);
assert.equal(
  ceilingSelection.sizeBytes,
  MAX_STATIC_BYTES,
  "the exact released 8 MiB static-render ceiling must remain admissible",
);

for (const terminalState of ["failed", "cancelled"]) {
  await assert.rejects(
    runCodeNode(
      selectRenderNode.config.source,
      renderSelectionContext({ run: { state: terminalState, manifest: null } }),
      null,
      2_000,
    ),
    new RegExp(`science run ended ${terminalState}`),
  );
}
await assert.rejects(
  runCodeNode(
    selectRenderNode.config.source,
    renderSelectionContext({
      run: { manifest: { complete: true } },
      manifestAssessment: {
        complete: false,
        gaps: ["manifest.compute.dependencyLock"],
      },
    }),
    null,
    2_000,
  ),
  /lacks a currently verified complete manifest/,
);
await assert.rejects(
  runCodeNode(
    selectRenderNode.config.source,
    renderSelectionContext({ run: { manifestHash: "not-a-checksum" } }),
    null,
    2_000,
  ),
  /manifest assessment hash is missing, invalid, or stale/,
);
await assert.rejects(
  runCodeNode(
    selectRenderNode.config.source,
    renderSelectionContext({
      outputs: [pngOutput({ version: { mediaType: "image/jpeg" } })],
    }),
    null,
    2_000,
  ),
  /no ready bounded image\/png output/,
);
await assert.rejects(
  runCodeNode(
    selectRenderNode.config.source,
    renderSelectionContext({
      outputs: [pngOutput({ version: { sha256: "g".repeat(64) } })],
    }),
    null,
    2_000,
  ),
  /no ready bounded image\/png output/,
);
for (const invalidSize of [0, MAX_STATIC_BYTES + 1]) {
  await assert.rejects(
    runCodeNode(
      selectRenderNode.config.source,
      renderSelectionContext({
        outputs: [pngOutput({ version: { sizeBytes: invalidSize } })],
      }),
      null,
      2_000,
    ),
    /no ready bounded image\/png output/,
  );
}
await assert.rejects(
  runCodeNode(
    selectRenderNode.config.source,
    renderSelectionContext({
      outputs: Array.from({ length: 201 }, () => pngOutput()),
    }),
    null,
    2_000,
  ),
  /exceeds the 200-item selection bound/,
);
await assert.rejects(
  runCodeNode(
    selectRenderNode.config.source,
    renderSelectionContext({
      outputs: [pngOutput({ version: { status: "pending" } })],
    }),
    null,
    2_000,
  ),
  /no ready bounded image\/png output/,
);

const selectedJson = JSON.stringify(selectedSource);
assert.doesNotMatch(selectedJson, /storageKey|providerHandle|quarantine|base64|data:/i);
assert.doesNotMatch(selectedJson, /"bytes"|"body"|"content"/i);
assert.equal("idempotencyKey" in selectedSource, false, "raw reviewed run key must not be re-emitted");

const renderResult = {
  renderSessionId: ids.renderSession,
  state: "ready",
  mode: "static",
  provider: "static",
  source: {
    artifactVersionId: selectedSource.artifactVersionId,
    sha256: selectedSource.sha256,
    mediaType: selectedSource.mediaType,
    sizeBytes: selectedSource.sizeBytes,
    logicalName: "plot.png",
  },
  url: `/api/science/render-sessions/${ids.renderSession}/gateway`,
  expiresAt: "2026-08-22T01:00:00.000Z",
};
const manifestResult = {
  runId: ids.run,
  state: "succeeded",
  manifest: { complete: true },
  manifestHash: manifestSha256,
  complete: true,
  gaps: [],
};
const finalContext = {
  select_static_render_source: selectedSource,
  "science__render.open": renderResult,
  "science__manifest.read": manifestResult,
};
const finalized = await runCodeNode(
  finalizeNode.config.source,
  finalContext,
  null,
  2_000,
);
assert.deepEqual(finalized, {
  runId: ids.run,
  artifactVersionId: ids.outputVersion,
  mediaType: "image/png",
  sha256: outputSha256,
  sizeBytes: 4096,
  semanticRole: "plot",
  render: {
    renderSessionId: ids.renderSession,
    mode: "static",
    url: `/api/science/render-sessions/${ids.renderSession}/gateway`,
    expiresAt: renderResult.expiresAt,
  },
  provenance: {
    complete: true,
    manifestHash: manifestSha256,
  },
});
const finalizedJson = JSON.stringify(finalized);
assert.ok(Buffer.byteLength(finalizedJson, "utf8") < 4_096, "final result must remain bounded");
assert.doesNotMatch(finalizedJson, /storageKey|providerHandle|quarantine|base64|data:/i);
assert.doesNotMatch(finalizedJson, /"bytes"|"body"|"content"/i);

await assert.rejects(
  runCodeNode(
    finalizeNode.config.source,
    {
      ...finalContext,
      "science__render.open": {
        ...renderResult,
        source: { ...renderResult.source, sha256: "d".repeat(64) },
      },
    },
    null,
    2_000,
  ),
  /render source does not match/,
);
await assert.rejects(
  runCodeNode(
    finalizeNode.config.source,
    {
      ...finalContext,
      "science__render.open": { ...renderResult, mode: "remote", provider: "trame" },
    },
    null,
    2_000,
  ),
  /static render did not become ready/,
);
await assert.rejects(
  runCodeNode(
    finalizeNode.config.source,
    {
      ...finalContext,
      "science__manifest.read": {
        ...manifestResult,
        complete: false,
        gaps: ["environment"],
        manifest: { complete: true },
      },
    },
    null,
    2_000,
  ),
  /provenance manifest is incomplete/,
);
await assert.rejects(
  runCodeNode(
    finalizeNode.config.source,
    {
      ...finalContext,
      "science__manifest.read": {
        ...manifestResult,
        manifestHash: "d".repeat(64),
      },
    },
    null,
    2_000,
  ),
  /does not match terminal status/,
);
await assert.rejects(
  runCodeNode(
    finalizeNode.config.source,
    {
      ...finalContext,
      "science__render.open": {
        ...renderResult,
        url: "http://internal-renderer.local/session/secret",
      },
    },
    null,
    2_000,
  ),
  /not the exact bounded same-origin gateway path/,
);

// Prove the executor persists and publishes the resolved exact-source prompt,
// not the placeholder. A malformed dynamic value must fail before any
// approval record exists, so there is no authorization bypass.
const approvalHandle = await createDb({ ephemeral: true });
try {
  await migrate(approvalHandle);
  const workspaceId = await ensureDefaultWorkspace(approvalHandle.db, "Science workflow approval verifier");
  const approvalGraph = WorkflowGraph.parse({
    nodes: [
      {
        id: "approval_trigger",
        kind: "trigger",
        label: "Manual",
        config: { mode: "manual" },
        position: { x: 40, y: 80 },
      },
      {
        id: "exact_source_approval",
        kind: "approval",
        label: "Approve exact source",
        config: { prompt: "{{input.approvalPrompt}}", tier: "write_approved" },
        position: { x: 280, y: 80 },
      },
    ],
    edges: [{ from: "approval_trigger", to: "exact_source_approval", condition: null }],
  });
  const created = await createWorkflow(approvalHandle.db, {
    workspaceId,
    name: "Exact static source approval verifier",
    graph: approvalGraph,
  });
  const published = [];
  const bus = new InMemoryEventBus();
  bus.subscribe((event) => published.push(event));
  const executor = new WorkflowExecutor({ db: approvalHandle.db, bus });
  const mission = await createMission(approvalHandle.db, {
    workspaceId,
    subjectId: created.workflow.id,
    workflowVersionId: created.version.id,
    trigger: { mode: "manual" },
    payload: { approvalPrompt: expectedApprovalPrompt },
  });
  assert.equal(await executor.runMission(mission.id), "awaiting_approval");
  const storedApproval = await findApprovalForNode(
    approvalHandle.db,
    mission.id,
    "exact_source_approval",
  );
  assert.equal(storedApproval?.prompt, expectedApprovalPrompt, "approval inbox stored the wrong prompt");
  assert.notEqual(storedApproval?.prompt, "{{input.approvalPrompt}}");
  assert.ok(
    published.some(
      (event) => event.type === "approval.requested" && event.prompt === expectedApprovalPrompt,
    ),
    "approval.requested did not publish the exact visible source prompt",
  );

  const malformedMission = await createMission(approvalHandle.db, {
    workspaceId,
    subjectId: created.workflow.id,
    workflowVersionId: created.version.id,
    trigger: { mode: "manual" },
    payload: { approvalPrompt: { disguised: expectedApprovalPrompt } },
  });
  assert.equal(await executor.runMission(malformedMission.id), "failed");
  assert.equal((await getMission(approvalHandle.db, malformedMission.id))?.status, "failed");
  assert.equal(
    await findApprovalForNode(approvalHandle.db, malformedMission.id, "exact_source_approval"),
    null,
    "malformed dynamic prompt created an approval record",
  );
} finally {
  await approvalHandle.close();
}

console.log(
  "SCIENCE WORKFLOW PASS: reviewed run intent, durable terminal wait, bounded checksummed PNG selection, exact visible static approval, stable replay key, exact render references, and complete manifest result",
);
