import { useEffect, useState } from "react";
import { Chip, HoldButton } from "@puppetmaster/ui";
import type {
  ScienceManifest,
  ScienceRun,
  ScienceRunComparison,
} from "../api.js";
import { fmtBytes, shortHash } from "./science-utils.js";

export function ManifestInspector(props: {
  manifest: ScienceManifest | null;
  manifestHash: string | null;
  loading: boolean;
  error: string | null;
  canBuild: boolean;
  newWorkEnabled: boolean;
  busy: boolean;
  comparisonCandidates: ScienceRun[];
  comparison: ScienceRunComparison | null;
  comparisonLoading: boolean;
  comparisonError: string | null;
  onCompare: (candidateRunId: string) => void;
  onReproduce: () => void;
}) {
  const [candidateRunId, setCandidateRunId] = useState("");
  const candidateKey = props.comparisonCandidates.map((run) => run.id).join(":");

  useEffect(() => {
    setCandidateRunId((current) =>
      props.comparisonCandidates.some((run) => run.id === current)
        ? current
        : props.comparisonCandidates[0]?.id ?? "",
    );
  }, [candidateKey, props.manifest?.runId]);

  if (props.loading) return <div className="sci-manifest sci-empty-inline">Loading canonical manifest…</div>;
  if (props.error) return <div className="sci-manifest"><p className="sci-error" role="alert">{props.error}</p></div>;
  if (!props.manifest) return <div className="sci-manifest sci-empty-inline">No manifest is available for this run.</div>;

  const manifest = props.manifest;
  return (
    <section className="sci-manifest" aria-label="Provenance manifest inspector">
      <div className={`sci-manifest-verdict ${manifest.complete ? "complete" : "incomplete"}`}>
        <span>{manifest.complete ? "MANIFEST COMPLETE" : "MANIFEST INCOMPLETE"}</span>
        <b>SHA {shortHash(props.manifestHash, 16)}</b>
      </div>
      <p className="sci-integrity-note">
        This verdict confirms provenance fields, not numerical or bitwise reproducibility.
      </p>
      {!manifest.complete && (
        <ul className="sci-gap-list" aria-label="Manifest completeness gaps">
          {manifest.gaps.length === 0 && <li>Server reported incomplete without named gaps.</li>}
          {manifest.gaps.map((gap) => <li key={gap}>{gap}</li>)}
        </ul>
      )}

      <div className="sci-manifest-grid">
        <section>
          <h4>INPUT LINEAGE</h4>
          <ul>
            {manifest.inputs.map((input) => (
              <li key={`${input.artifactVersionId}:${input.semanticRole}`}>
                <span>{input.logicalName ?? input.artifactVersionId.slice(0, 12)}</span>
                <b>{input.semanticRole}</b>
                <small>SHA {shortHash(input.sha256)} · {fmtBytes(input.sizeBytes)}</small>
              </li>
            ))}
            {manifest.inputs.length === 0 && <li className="sci-state-note">NO INPUT REFERENCES</li>}
          </ul>
        </section>
        <section>
          <h4>OUTPUT LINEAGE</h4>
          <ul>
            {manifest.outputs.map((output) => (
              <li key={`${output.artifactVersionId}:${output.semanticRole}`}>
                <span>{output.logicalName ?? output.artifactVersionId.slice(0, 12)}</span>
                <b>{output.semanticRole}</b>
                <small>SHA {shortHash(output.sha256)} · {fmtBytes(output.sizeBytes)}</small>
              </li>
            ))}
            {manifest.outputs.length === 0 && <li className="sci-state-note">NO OUTPUT REFERENCES</li>}
          </ul>
        </section>
      </div>

      <dl className="sci-manifest-facts">
        <dt>IMAGE DIGEST</dt><dd>{manifest.compute.imageDigest}</dd>
        <dt>KERNEL</dt><dd>{manifest.compute.kernelName}</dd>
        <dt>ADAPTER</dt><dd>{manifest.compute.adapterVersion}</dd>
        <dt>SOURCE REVISION</dt><dd>{manifest.sourceRevision ?? "N/A"}</dd>
        <dt>VALIDATIONS</dt><dd>{manifest.validations.length}</dd>
        <dt>LIMITATIONS</dt><dd>{manifest.limitations.length}</dd>
      </dl>

      <section className="sci-comparison" aria-label="Re-run provenance comparison">
        <div className="sci-config-head">
          <span>RE-RUN COMPARISON</span>
          <span>PROVENANCE ≠ NUMERICAL EQUIVALENCE</span>
        </div>
        <div className="sci-comparison-controls">
          <label className="sci-field">
            <span>Candidate succeeded run</span>
            <select
              value={candidateRunId}
              disabled={props.comparisonLoading || props.comparisonCandidates.length === 0}
              onChange={(event) => setCandidateRunId(event.target.value)}
            >
              {props.comparisonCandidates.length === 0 && (
                <option value="">NO OTHER SUCCEEDED RUN ON THIS PAGE</option>
              )}
              {props.comparisonCandidates.map((run) => (
                <option key={run.id} value={run.id}>
                  OP {run.id.slice(0, 8)} · SHA {shortHash(run.manifestHash, 12)}
                </option>
              ))}
            </select>
          </label>
          <Chip
            tiny
            disabled={!candidateRunId || props.comparisonLoading}
            onClick={() => props.onCompare(candidateRunId)}
          >
            {props.comparisonLoading ? "COMPARING…" : "COMPARE"}
          </Chip>
        </div>
        {props.comparisonError && (
          <p className="sci-error" role="alert">{props.comparisonError}</p>
        )}
        {props.comparison && (
          <>
            <dl className="sci-manifest-facts sci-comparison-facts">
              <dt>EXACT INPUTS</dt>
              <dd>{props.comparison.comparison.sameInputs ? "MATCH" : "DIFFER"}</dd>
              <dt>PARAMETERS</dt>
              <dd>{props.comparison.comparison.sameParameters ? "MATCH" : "DIFFER"}</dd>
              <dt>ENVIRONMENT</dt>
              <dd>{props.comparison.comparison.sameEnvironment ? "MATCH" : "DIFFER"}</dd>
              <dt>OUTPUT IDENTITY</dt>
              <dd>{props.comparison.comparison.sameOutputs ? "MATCH" : "DIFFER"}</dd>
              <dt>NUMERICAL RESULT</dt>
              <dd>
                {props.comparison.comparison.numericallyEquivalent === null
                  ? "NOT ASSESSED — NO DECLARED TOLERANCE RESULT"
                  : props.comparison.comparison.numericallyEquivalent
                    ? "WITHIN DECLARED TOLERANCE"
                    : "OUTSIDE DECLARED TOLERANCE"}
              </dd>
              <dt>DECLARED METRIC</dt>
              <dd>
                {props.comparison.comparison.numericalValidation?.metric ??
                  "NOT DECLARED"}
              </dd>
              <dt>TOLERANCE</dt>
              <dd>
                {props.comparison.comparison.numericalValidation?.tolerance == null
                  ? "NOT DECLARED"
                  : JSON.stringify(
                      props.comparison.comparison.numericalValidation.tolerance,
                    )}
              </dd>
              <dt>OBSERVED</dt>
              <dd>
                {props.comparison.comparison.numericalValidation?.observed == null
                  ? "NOT DECLARED"
                  : `${props.comparison.comparison.numericalValidation.observed}${
                      props.comparison.comparison.numericalValidation.units
                        ? ` ${props.comparison.comparison.numericalValidation.units}`
                        : ""
                    }`}
              </dd>
            </dl>
            <p className="sci-integrity-note" aria-live="polite">
              Compared OP {props.comparison.leftRunId.slice(0, 8)} with OP{" "}
              {props.comparison.rightRunId.slice(0, 8)}. Differences:{" "}
              {props.comparison.comparison.differences.join(", ") || "none"}.
            </p>
          </>
        )}
      </section>

      {manifest.limitations && manifest.limitations.length > 0 && (
        <details>
          <summary>DECLARED LIMITATIONS</summary>
          <ul className="sci-gap-list">
            {manifest.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </details>
      )}
      <details>
        <summary>CANONICAL PARAMETERS + ENVIRONMENT</summary>
        <pre>{JSON.stringify({
          parameters: manifest.parameters,
          units: manifest.units,
          compute: manifest.compute,
          randomSeeds: manifest.randomSeeds,
          environment: manifest.environment,
          actorId: manifest.actorId,
          approvalIds: manifest.approvalIds,
          policyIds: manifest.policyIds,
          toolCalls: manifest.toolCalls,
          validations: manifest.validations,
        }, null, 2)}</pre>
      </details>

      {props.canBuild && (
        <div className="sci-ceremony">
          <HoldButton
            disabled={!props.newWorkEnabled || props.busy || !manifest.complete}
            onComplete={props.onReproduce}
            title="Hold to submit a new run from this exact manifest"
          >
            HOLD TO RE-RUN MANIFEST
          </HoldButton>
          <span>A re-run creates a new run and comparison target; it does not rewrite this manifest.</span>
        </div>
      )}
    </section>
  );
}
