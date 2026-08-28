import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { Chip, Decode, HoldButton, StatusDot } from "@puppetmaster/ui";
import type { ScienceRun } from "../api.js";
import {
  fmtBytes,
  fmtClock,
  fmtElapsed,
  SCIENCE_ACTIVE_RUN_STATES,
  shortHash,
} from "./science-utils.js";

type DossierTab = "run" | "configure" | "manifest";

export function RunDossier(props: {
  runs: ScienceRun[];
  runsLoading: boolean;
  runsError: string | null;
  selectedRun: ScienceRun | null;
  selectedRunId: string | null;
  onSelectRun: (run: ScienceRun) => void;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  canBuild: boolean;
  busy: boolean;
  onRefresh: () => void;
  onCancel: () => void;
  configurator: ReactNode;
  manifestInspector: ReactNode;
}) {
  const [tab, setTab] = useState<DossierTab>("run");
  const dossierId = useId();
  const run = props.selectedRun;

  const moveTab = (event: KeyboardEvent<HTMLDivElement>) => {
    const order: DossierTab[] = ["run", "configure", "manifest"];
    const current = order.indexOf(tab);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? order.length - 1
        : event.key === "ArrowRight"
          ? (current + 1) % order.length
          : event.key === "ArrowLeft"
            ? (current - 1 + order.length) % order.length
            : -1;
    if (next < 0) return;
    event.preventDefault();
    const nextTab = order[next]!;
    setTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`${dossierId}-tab-${nextTab}`)?.focus());
  };

  return (
    <aside className="sci-dossier" aria-label="Scientific run dossier">
      <div className="sci-dossier-tabs" role="tablist" aria-label="Run dossier sections" onKeyDown={moveTab}>
        {(["run", "configure", "manifest"] as const).map((item) => (
          <button
            key={item}
            id={`${dossierId}-tab-${item}`}
            type="button"
            role="tab"
            aria-selected={tab === item}
            aria-controls={`${dossierId}-panel-${item}`}
            tabIndex={tab === item ? 0 : -1}
            className={tab === item ? "on" : ""}
            onClick={() => setTab(item)}
          >
            {item.toUpperCase()}
          </button>
        ))}
      </div>

      <div
        id={`${dossierId}-panel-configure`}
        className="sci-dossier-body"
        role="tabpanel"
        aria-labelledby={`${dossierId}-tab-configure`}
        hidden={tab !== "configure"}
      >
        {props.configurator}
      </div>
      <div
        id={`${dossierId}-panel-manifest`}
        className="sci-dossier-body"
        role="tabpanel"
        aria-labelledby={`${dossierId}-tab-manifest`}
        hidden={tab !== "manifest"}
      >
        {props.manifestInspector}
      </div>
      <div
        id={`${dossierId}-panel-run`}
        className="sci-dossier-body"
        role="tabpanel"
        aria-labelledby={`${dossierId}-tab-run`}
        hidden={tab !== "run"}
      >
          <section className="sci-run-picker" aria-label="Runs in selected study">
            <div className="sci-subhead">
              <span>RUNS //</span>
              <Chip tiny onClick={props.onRefresh} disabled={props.runsLoading}>↻ REFRESH</Chip>
            </div>
            {props.runsError && <p className="sci-error" role="alert">{props.runsError}</p>}
            <div className="sci-run-list" role="group" aria-label="Scientific runs">
              {props.runs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={item.id === props.selectedRunId}
                  className={item.id === props.selectedRunId ? "sel" : ""}
                  onClick={() => props.onSelectRun(item)}
                >
                  <StatusDot status={item.state} pulse={item.state === "running"} />
                  <span>OP {item.id.slice(0, 8)}</span>
                  <small>{item.state.replace(/_/g, " ").toUpperCase()}</small>
                </button>
              ))}
              {!props.runsLoading && props.runs.length === 0 && <p className="sci-empty-inline">No runs in this study.</p>}
              {props.runsLoading && props.runs.length === 0 && <p className="sci-empty-inline">Loading runs…</p>}
            </div>
            <div className="sci-pager">
              <Chip tiny disabled={!props.hasPreviousPage} onClick={props.onPreviousPage}>‹ PREV</Chip>
              <span>RUN PAGE</span>
              <Chip tiny disabled={!props.hasNextPage} onClick={props.onNextPage}>NEXT ›</Chip>
            </div>
          </section>

          {!run && <div className="sci-empty-inline">Select a run or open CONFIGURE to submit one.</div>}
          {run && (
            <>
              <section className={`sci-run-verdict state-${run.state}`} aria-live="polite">
                <span>RUN STATE</span>
                <b><Decode text={run.state.replace(/_/g, " ").toUpperCase()} /></b>
                <small>GEN {run.executionGeneration} · MISSION {run.missionId?.slice(0, 8) || "N/A"}</small>
              </section>

              <dl className="sci-dossier-facts">
                <dt>PROFILE</dt><dd>{run.profileName ?? run.profileSnapshot.kernelName ?? run.computeProfileId}</dd>
                <dt>PROVIDER</dt><dd>{run.profileSnapshot.providerKind.toUpperCase()}</dd>
                <dt>PROGRESS</dt><dd>{run.progress == null ? "N/A" : `${Math.round(run.progress * (run.progress <= 1 ? 100 : 1))}%`}</dd>
                <dt>QUEUED</dt><dd>{fmtClock(run.queuedAt)}</dd>
                <dt>QUEUE AGE</dt><dd>{fmtElapsed(run.queuedAt, run.startedAt)}</dd>
                <dt>WALL TIME</dt><dd>{fmtElapsed(run.startedAt, run.finishedAt)}</dd>
                <dt>MANIFEST</dt><dd>{shortHash(run.manifestHash, 16)}</dd>
                <dt>IDEMPOTENCY</dt><dd>{shortHash(run.idempotencyKey, 16)}</dd>
              </dl>

              <details open>
                <summary>PARAMETERS + RESOURCES</summary>
                <pre>{JSON.stringify({
                  parameters: run.parameters,
                  requestedResources: run.resourceRequest,
                }, null, 2)}</pre>
              </details>

              <section className="sci-lineage">
                <h4>INPUT / OUTPUT REFERENCES</h4>
                {[...(run.inputs ?? []), ...(run.outputs ?? [])].map((ref) => (
                  <div key={`${ref.direction}:${ref.artifactVersionId}:${ref.semanticRole}`}>
                    <span className={`sci-io-tag ${ref.direction}`}>{ref.direction.toUpperCase()}</span>
                    <b>{ref.logicalName ?? ref.artifactVersionId.slice(0, 12)}</b>
                    <small>{ref.semanticRole} · SHA {shortHash(ref.sha256)} · {fmtBytes(ref.sizeBytes)}</small>
                  </div>
                ))}
                {(run.inputs?.length ?? 0) + (run.outputs?.length ?? 0) === 0 && (
                  <p className="sci-state-note">NO LINKED ARTIFACT REFERENCES YET</p>
                )}
              </section>

              <section className="sci-event-log" aria-label="Recent bounded run events">
                <h4>RECENT EVENTS</h4>
                <ol tabIndex={0} aria-label="Scrollable recent run events">
                  {(run.recentEvents ?? []).slice(-40).reverse().map((event) => (
                    <li key={event.sequence}>
                      <time dateTime={event.createdAt}>{fmtClock(event.createdAt)}</time>
                      <span>{event.eventType}</span>
                      <b>
                        {typeof event.payload.message === "string"
                          ? event.payload.message
                          : event.state.replace(/_/g, " ").toUpperCase()}
                      </b>
                    </li>
                  ))}
                  {(run.recentEvents?.length ?? 0) === 0 && <li className="sci-state-note">NO BOUNDED EVENTS RETURNED</li>}
                </ol>
              </section>

              {run.error && <pre className="sci-run-error" role="alert">{run.error}</pre>}
              {props.canBuild && SCIENCE_ACTIVE_RUN_STATES.has(run.state) && (
                <div className="sci-ceremony">
                  <HoldButton
                    tone="danger"
                    disabled={props.busy}
                    onComplete={props.onCancel}
                    title="Hold to abort this exact run generation"
                  >
                    HOLD TO ABORT GEN {run.executionGeneration}
                  </HoldButton>
                  <span>Cancellation is cooperative, then provider-enforced.</span>
                </div>
              )}
            </>
          )}
      </div>
    </aside>
  );
}
