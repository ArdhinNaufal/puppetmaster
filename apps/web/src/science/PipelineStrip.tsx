import type { ScienceArtifact, ScienceManifest, ScienceRun } from "../api.js";

type StageState = "pending" | "active" | "done" | "failed" | "gap" | "ready";

interface Stage {
  id: string;
  label: string;
  state: StageState;
  detail: string;
}

function deriveStages(
  artifacts: ScienceArtifact[],
  run: ScienceRun | null,
  manifest: ScienceManifest | null,
): Stage[] {
  const readyArtifacts = artifacts.filter((artifact) => artifact.latestVersion?.status === "ready").length;
  const runState = run?.state ?? null;
  const authorizationEnded = runState === "cancelled";
  const afterApproval =
    runState !== null && !["draft", "awaiting_approval", "cancelled"].includes(runState);
  const afterExecution = runState !== null && ["finalizing", "succeeded"].includes(runState);
  const terminalFailure = runState === "failed" || runState === "cancelled";

  return [
    {
      id: "ingest",
      label: "INGEST",
      state: readyArtifacts > 0 ? "done" : "active",
      detail: readyArtifacts > 0 ? `${readyArtifacts} ready immutable version${readyArtifacts === 1 ? "" : "s"}` : "No ready input versions",
    },
    {
      id: "prepare",
      label: "PREPARE",
      state: run
        ? runState === "draft" ? "active" : "done"
        : readyArtifacts > 0 ? "active" : "pending",
      detail: run ? `Run ${run.id.slice(0, 8)} configured` : "Configure profile, inputs, parameters, and resources",
    },
    {
      id: "authorize",
      label: "AUTHORIZE",
      state: runState === "awaiting_approval"
        ? "active"
        : authorizationEnded
          ? "failed"
          : afterApproval
            ? "done"
            : "pending",
      detail: runState === "awaiting_approval"
        ? "Operator decision pending"
        : authorizationEnded
          ? "Run cancelled; authorization clearance is not inferred"
          : afterApproval
            ? "Gate cleared or policy did not require it"
            : "Not submitted",
    },
    {
      id: "execute",
      label: "EXECUTE",
      state: terminalFailure
        ? "failed"
        : afterExecution
          ? "done"
          : runState && ["queued", "provisioning", "running", "cancelling"].includes(runState)
            ? "active"
            : "pending",
      detail: runState ? `Persisted run state: ${runState.replace(/_/g, " ")}` : "No run",
    },
    {
      id: "verify",
      label: "VERIFY",
      state: runState === "finalizing"
        ? "active"
        : runState === "succeeded"
          ? manifest?.complete ? "done" : "gap"
          : terminalFailure ? "failed" : "pending",
      detail: runState === "succeeded"
        ? manifest?.complete ? "Manifest complete" : "Manifest incomplete"
        : runState === "finalizing" ? "Outputs, checksums, and manifest are finalizing" : "Awaiting finalized outputs",
    },
    {
      id: "release",
      label: "RELEASE / RE-RUN",
      state: runState === "succeeded" && manifest?.complete ? "ready" : "pending",
      detail: runState === "succeeded" && manifest?.complete
        ? "Manifest is eligible for deliberate release or re-run"
        : "Requires a successful run and complete manifest",
    },
  ];
}

export function PipelineStrip(props: {
  artifacts: ScienceArtifact[];
  run: ScienceRun | null;
  manifest: ScienceManifest | null;
}) {
  const stages = deriveStages(props.artifacts, props.run, props.manifest);
  return (
    <ol className="sci-pipeline" aria-label="Scientific computation pipeline">
      {stages.map((stage, index) => (
        <li
          key={stage.id}
          className={`sci-pipeline-stage state-${stage.state}`}
          tabIndex={0}
          aria-current={stage.state === "active" ? "step" : undefined}
          aria-label={`${stage.label}: ${stage.detail}`}
        >
          <span className="sci-pipeline-index">{String(index + 1).padStart(2, "0")}</span>
          <span className="sci-pipeline-label">{stage.label}</span>
          <span className="sci-pipeline-state">{stage.state.toUpperCase()}</span>
        </li>
      ))}
    </ol>
  );
}
