import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip, HoldButton } from "@puppetmaster/ui";
import {
  scienceApi,
  type ScienceDomainValidationDetail,
  type ScienceDomainValidationInput,
  type ScienceDomainValidationSummary,
  type SciencePage,
  type ScienceRun,
  type ScienceValidationOutputChecksum,
} from "../api.js";
import { fmtBytes, scienceError, shortHash } from "./science-utils.js";

const VALIDATION_PAGE_SIZE = 10;
const EMPTY_PAGE: SciencePage<ScienceDomainValidationSummary> = {
  items: [],
  nextCursor: null,
};

type ValidationKind = ScienceDomainValidationInput["kind"];

function finiteNumber(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ValidationChecksums(props: {
  label: string;
  items: ScienceValidationOutputChecksum[] | null;
}) {
  if (props.items === null) return null;
  return (
    <details className="sci-validation-checksums">
      <summary>{props.label} ({props.items.length})</summary>
      <ul tabIndex={0} aria-label={`${props.label} checksum bindings`}>
        {props.items.map((item) => (
          <li key={`${item.artifactVersionId}:${item.semanticRole}`}>
            <b>{item.semanticRole}</b>
            <span>{item.artifactVersionId}</span>
            <small title={item.sha256}>
              SHA {shortHash(item.sha256, 16)} · {fmtBytes(item.sizeBytes)}
            </small>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function DomainValidationPanel(props: {
  runId: string;
  isAdmin: boolean;
  authoringReady: boolean;
  comparisonCandidates: ScienceRun[];
}) {
  const [page, setPage] = useState<SciencePage<ScienceDomainValidationSummary>>(EMPTY_PAGE);
  const [cursor, setCursor] = useState<string | null>(null);
  const [back, setBack] = useState<(string | null)[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScienceDomainValidationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [kind, setKind] = useState<ValidationKind>("domain-validation");
  const [baselineRunId, setBaselineRunId] = useState("");
  const [metric, setMetric] = useState("");
  const [tolerance, setTolerance] = useState("");
  const [observedValue, setObservedValue] = useState("");
  const [units, setUnits] = useState("");
  const [methodProtocolId, setMethodProtocolId] = useState("");
  const [decision, setDecision] = useState<"pass" | "fail">("pass");
  const [limitationsReason, setLimitationsReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const submissionRequest = useRef(0);

  const baselineCandidates = useMemo(
    () => props.comparisonCandidates.filter(
      (run) =>
        run.id !== props.runId &&
        run.state === "succeeded" &&
        Boolean(run.manifestHash),
    ),
    [props.comparisonCandidates, props.runId],
  );
  const baselineKey = baselineCandidates.map((run) => run.id).join(":");

  const loadPage = useCallback(async (
    targetCursor: string | null,
    preferredId?: string,
  ) => {
    const request = ++listRequest.current;
    setLoading(true);
    try {
      const next = await scienceApi.domainValidations(props.runId, {
        cursor: targetCursor,
        limit: VALIDATION_PAGE_SIZE,
      });
      if (request !== listRequest.current) return;
      setPage(next);
      setListError(null);
      setSelectedId((current) => {
        if (preferredId && next.items.some((item) => item.id === preferredId)) return preferredId;
        if (next.items.some((item) => item.id === current)) return current;
        return next.items[0]?.id ?? null;
      });
    } catch (error) {
      if (request !== listRequest.current) return;
      setPage(EMPTY_PAGE);
      setSelectedId(null);
      setListError(scienceError(error));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [props.runId]);

  useEffect(() => {
    listRequest.current++;
    detailRequest.current++;
    submissionRequest.current++;
    setPage(EMPTY_PAGE);
    setCursor(null);
    setBack([]);
    setSelectedId(null);
    setDetail(null);
    setListError(null);
    setDetailError(null);
    setSubmissionError(null);
    setAnnouncement("");
    setSubmitting(false);
    void loadPage(null);
  }, [loadPage, props.runId]);

  useEffect(() => {
    if (!selectedId) {
      detailRequest.current++;
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    const request = ++detailRequest.current;
    setDetailLoading(true);
    scienceApi.domainValidation(props.runId, selectedId).then((next) => {
      if (request !== detailRequest.current) return;
      setDetail(next);
      setDetailError(null);
    }).catch((error) => {
      if (request !== detailRequest.current) return;
      setDetail(null);
      setDetailError(scienceError(error));
    }).finally(() => {
      if (request === detailRequest.current) setDetailLoading(false);
    });
  }, [props.runId, selectedId]);

  useEffect(() => {
    setBaselineRunId((current) =>
      baselineCandidates.some((run) => run.id === current)
        ? current
        : baselineCandidates[0]?.id ?? "",
    );
  }, [baselineKey]);

  const toleranceNumber = finiteNumber(tolerance);
  const observedNumber = finiteNumber(observedValue);
  const formValid =
    props.authoringReady &&
    metric.trim().length >= 1 && metric.trim().length <= 200 &&
    toleranceNumber !== null && toleranceNumber >= 0 &&
    observedNumber !== null &&
    units.trim().length >= 1 && units.trim().length <= 100 &&
    methodProtocolId.trim().length >= 1 && methodProtocolId.trim().length <= 300 &&
    limitationsReason.trim().length >= 1 && limitationsReason.trim().length <= 2_000 &&
    (kind === "domain-validation" || baselineCandidates.some((run) => run.id === baselineRunId));

  const resetEvidence = () => {
    setMetric("");
    setTolerance("");
    setObservedValue("");
    setUnits("");
    setMethodProtocolId("");
    setDecision("pass");
    setLimitationsReason("");
  };

  const submit = async () => {
    if (!props.isAdmin || !formValid || submitting || toleranceNumber === null || observedNumber === null) {
      return;
    }
    const request = ++submissionRequest.current;
    const submissionRunId = props.runId;
    const input: ScienceDomainValidationInput = {
      kind,
      ...(kind === "numerical-equivalence" ? { baselineRunId } : {}),
      metric: metric.trim(),
      tolerance: toleranceNumber,
      observedValue: observedNumber,
      units: units.trim(),
      methodProtocolId: methodProtocolId.trim(),
      decision: decision === "pass",
      limitationsReason: limitationsReason.trim(),
    };
    setSubmitting(true);
    setSubmissionError(null);
    setAnnouncement("");
    try {
      const created = await scienceApi.createDomainValidation(submissionRunId, input);
      if (request !== submissionRequest.current) return;
      setCursor(null);
      setBack([]);
      setSelectedId(created.id);
      setDetail(created);
      resetEvidence();
      setAnnouncement(
        `Immutable validation revision ${created.revision} appended. Record ${shortHash(created.recordHash, 16)}.`,
      );
      await loadPage(null, created.id);
    } catch (error) {
      if (request !== submissionRequest.current) return;
      setSubmissionError(scienceError(error));
    } finally {
      if (request === submissionRequest.current) setSubmitting(false);
    }
  };

  const previousPage = () => {
    if (loading || back.length === 0) return;
    const target = back[back.length - 1] ?? null;
    setBack((current) => current.slice(0, -1));
    setCursor(target);
    void loadPage(target);
  };

  const nextPage = () => {
    if (loading || !page.nextCursor) return;
    const target = page.nextCursor;
    setBack((current) => [...current, cursor]);
    setCursor(target);
    void loadPage(target);
  };

  return (
    <section className="sci-validation" aria-label="Immutable domain validation ledger">
      <div className="sci-config-head">
        <span>DOMAIN VALIDATION LEDGER</span>
        <span>APPEND-ONLY · PROVENANCE-BOUND</span>
      </div>
      <p className="sci-integrity-note">
        Members can read every retained review. A decision is human scientific evidence,
        not a change to either run manifest. Browser automation and example values are
        <b> SYNTHETIC / NON-RELEASE</b>.
      </p>

      <div className="sci-validation-browser">
        <section aria-label="Validation record summaries">
          <div className="sci-validation-list-head">
            <span>RETAINED REVISIONS</span>
            <span>PAGE {back.length + 1}</span>
          </div>
          {listError && <p className="sci-error" role="alert">{listError}</p>}
          {loading && page.items.length === 0 && (
            <p className="sci-empty-inline" role="status">Loading validation records…</p>
          )}
          {!loading && !listError && page.items.length === 0 && (
            <p className="sci-empty-inline">No domain review is recorded. Scientific validation is not established.</p>
          )}
          <ol className="sci-validation-list" aria-label="Append-only validation revisions">
            {page.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={item.id === selectedId ? "sel" : ""}
                  aria-pressed={item.id === selectedId}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span>REV {item.revision} · {item.kind === "numerical-equivalence" ? "NUMERICAL" : "DOMAIN"}</span>
                  <b className={item.decision ? "pass" : "fail"}>{item.decision ? "PASS" : "FAIL"}</b>
                  <small>{item.metric} · {item.observedValue} {item.units} · TOL {item.tolerance}</small>
                  <time dateTime={item.createdAt}>{item.createdAt}</time>
                </button>
              </li>
            ))}
          </ol>
          <div className="sci-pager sci-validation-pager" aria-label="Validation record pages">
            <Chip tiny disabled={loading || back.length === 0} onClick={previousPage}>PREVIOUS RECORDS</Chip>
            <Chip tiny disabled={loading || !page.nextCursor} onClick={nextPage}>NEXT RECORDS</Chip>
          </div>
        </section>

        <section className="sci-validation-detail" aria-label="Selected validation detail" aria-live="polite">
          <h4>CHECKSUM-BOUND DETAIL</h4>
          {detailLoading && <p className="sci-empty-inline">Loading selected record…</p>}
          {detailError && <p className="sci-error" role="alert">{detailError}</p>}
          {!detailLoading && !detailError && !detail && (
            <p className="sci-empty-inline">Select a retained revision to inspect its exact evidence.</p>
          )}
          {detail && detail.id === selectedId && (
            <>
              <dl className="sci-manifest-facts sci-validation-facts">
                <dt>REVISION</dt><dd>{detail.revision}</dd>
                <dt>DECISION</dt><dd>{detail.decision ? "PASS" : "FAIL"}</dd>
                <dt>KIND</dt><dd>{detail.kind}</dd>
                <dt>METRIC</dt><dd>{detail.metric}</dd>
                <dt>OBSERVED</dt><dd>{detail.observedValue} {detail.units}</dd>
                <dt>TOLERANCE</dt><dd>{detail.tolerance}</dd>
                <dt>METHOD / PROTOCOL</dt><dd>{detail.methodProtocolId}</dd>
                <dt>REVIEWER</dt><dd>{detail.reviewerRole} · {detail.reviewerId}</dd>
                <dt>CREATED</dt><dd><time dateTime={detail.createdAt}>{detail.createdAt}</time></dd>
                <dt>CANDIDATE MANIFEST</dt><dd>{detail.runManifestHash}</dd>
                <dt>BASELINE RUN</dt><dd>{detail.baselineRunId ?? "NOT LINKED"}</dd>
                <dt>BASELINE MANIFEST</dt><dd>{detail.baselineManifestHash ?? "NOT LINKED"}</dd>
                <dt>RECORD HASH</dt><dd>{detail.recordHash}</dd>
              </dl>
              <div className="sci-validation-limitations">
                <h4>LIMITATIONS / REASON</h4>
                <p>{detail.limitationsReason}</p>
              </div>
              <ValidationChecksums label="CANDIDATE OUTPUTS" items={detail.runOutputChecksums} />
              <ValidationChecksums label="BASELINE OUTPUTS" items={detail.baselineOutputChecksums} />
            </>
          )}
        </section>
      </div>

      {props.isAdmin && (
        <details className="sci-validation-author">
          <summary>APPEND DOMAIN REVIEW · ADMIN / OWNER</summary>
          <p className="sci-integrity-note">
            Reviewer ID and role come from the signed-in session. This form has no edit,
            delete, reviewer, revision, timestamp, manifest-hash, checksum, or record-hash fields.
            A correction must be a new revision with an explicit reason.
          </p>
          {!props.authoringReady && (
            <p className="sci-error" role="alert">
              Authoring requires a succeeded candidate with an intact manifest and at least one output.
            </p>
          )}
          <form className="sci-validation-form" onSubmit={(event) => event.preventDefault()}>
            <fieldset disabled={submitting || !props.authoringReady}>
              <legend>Review scope and bounded evidence</legend>
              <label className="sci-field">
                <span>Review kind</span>
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as ValidationKind)}
                >
                  <option value="domain-validation">STANDALONE DOMAIN VALIDATION</option>
                  <option value="numerical-equivalence">LINKED NUMERICAL EQUIVALENCE</option>
                </select>
              </label>

              {kind === "numerical-equivalence" ? (
                <label className="sci-field">
                  <span>Baseline succeeded run with manifest</span>
                  <select
                    required
                    value={baselineRunId}
                    onChange={(event) => setBaselineRunId(event.target.value)}
                  >
                    {baselineCandidates.length === 0 && (
                      <option value="">NO ELIGIBLE BASELINE ON THIS RUN PAGE</option>
                    )}
                    {baselineCandidates.map((run) => (
                      <option key={run.id} value={run.id}>
                        OP {run.id.slice(0, 8)} · SHA {shortHash(run.manifestHash, 12)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="sci-validation-scope-note">
                  Standalone domain validation links no baseline and makes no equivalence claim.
                </p>
              )}

              <div className="sci-validation-evidence-grid">
                <label className="sci-field">
                  <span>Metric</span>
                  <input required maxLength={200} value={metric} onChange={(event) => setMetric(event.target.value)} />
                </label>
                <label className="sci-field">
                  <span>Tolerance (zero or greater)</span>
                  <input required type="number" min="0" step="any" value={tolerance} onChange={(event) => setTolerance(event.target.value)} />
                </label>
                <label className="sci-field">
                  <span>Observed value</span>
                  <input required type="number" step="any" value={observedValue} onChange={(event) => setObservedValue(event.target.value)} />
                </label>
                <label className="sci-field">
                  <span>Units</span>
                  <input required maxLength={100} value={units} onChange={(event) => setUnits(event.target.value)} />
                </label>
                <label className="sci-field sci-validation-protocol">
                  <span>Method / protocol identifier</span>
                  <input required maxLength={300} value={methodProtocolId} onChange={(event) => setMethodProtocolId(event.target.value)} />
                </label>
              </div>

              <fieldset className="sci-validation-decision">
                <legend>Decision</legend>
                <label><input type="radio" name="science-validation-decision" checked={decision === "pass"} onChange={() => setDecision("pass")} /> PASS</label>
                <label><input type="radio" name="science-validation-decision" checked={decision === "fail"} onChange={() => setDecision("fail")} /> FAIL</label>
              </fieldset>

              <label className="sci-field">
                <span>Limitations / reason (mandatory)</span>
                <textarea
                  required
                  maxLength={2_000}
                  rows={4}
                  value={limitationsReason}
                  onChange={(event) => setLimitationsReason(event.target.value)}
                />
              </label>
            </fieldset>

            {submissionError && <p className="sci-error" role="alert">{submissionError}</p>}
            <div className="sci-ceremony">
              <HoldButton
                disabled={!formValid || submitting}
                onComplete={() => void submit()}
                title="Hold to append an immutable, session-attributed validation revision"
              >
                {submitting ? "APPENDING…" : "HOLD TO APPEND REVIEW"}
              </HoldButton>
              <span>This creates a new immutable revision. It cannot edit or delete earlier evidence.</span>
            </div>
          </form>
        </details>
      )}

      <p className="sci-validation-announcement" role="status" aria-live="polite">{announcement}</p>
    </section>
  );
}
