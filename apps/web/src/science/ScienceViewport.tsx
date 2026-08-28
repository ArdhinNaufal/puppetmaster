import { useEffect, useMemo, useRef, useState } from "react";
import { Chip, HoldButton } from "@puppetmaster/ui";
import {
  scienceApi,
  type ScienceArtifact,
  type ScienceRenderSession,
  type ScienceRun,
  type ScienceRunArtifactRef,
} from "../api.js";
import { fmtBytes, shortHash } from "./science-utils.js";
import {
  GeometryPreview,
  SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES,
  type GeometryPreviewModel,
} from "./GeometryPreview.js";

export type ScienceFallbackMode = "auto" | "static" | "table";
type SciencePalette = "cividis" | "viridis" | "coolwarm" | "grayscale";

const INLINE_STATIC_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function metadataRows(artifact: ScienceArtifact | null, run: ScienceRun | null): [string, string][] {
  const version = artifact?.latestVersion ?? null;
  const metadata = version?.metadata ?? {};
  const rows: [string, string][] = [
    ["ARTIFACT", artifact?.logicalName ?? "N/A"],
    ["FORMAT", artifact?.format?.toUpperCase() ?? "N/A"],
    ["VERSION", version ? `v${version.version}` : "N/A"],
    ["STATUS", version?.status?.toUpperCase() ?? artifact?.status?.toUpperCase() ?? "N/A"],
    ["SHA-256", version?.sha256 ?? "N/A"],
    ["SIZE", fmtBytes(version?.sizeBytes)],
    ["MEDIA TYPE", version?.mediaType ?? "N/A"],
    ["RUN", run?.id ?? "N/A"],
    ["RUN STATE", run?.state?.replace(/_/g, " ").toUpperCase() ?? "N/A"],
  ];
  for (const key of ["shape", "schema", "dimensions", "field", "units", "range", "missingValue"]) {
    const value = metadata[key];
    if (value !== undefined) rows.push([key.replace(/[A-Z]/g, (c) => ` ${c}`).toUpperCase(), typeof value === "string" ? value : JSON.stringify(value)]);
  }
  return rows;
}

function renderSourceRows(session: ScienceRenderSession): [string, string][] {
  return [
    ["RENDER SOURCE", session.source.logicalName],
    ["ARTIFACT VERSION ID", session.source.artifactVersionId ?? "N/A"],
    ["SHA-256", session.source.sha256],
    ["SIZE", fmtBytes(session.source.sizeBytes)],
    ["MEDIA TYPE", session.source.mediaType],
    ["MODE", session.mode.toUpperCase()],
    ["PROVIDER", session.provider.toUpperCase()],
    ["RUN", session.runId ?? "N/A"],
    ["SESSION STATE", session.state.toUpperCase()],
  ];
}

function sameOriginRenderUrl(value: string | null | undefined): string | null {
  if (!value || !globalThis.location) return null;
  try {
    const url = new URL(value, globalThis.location.href);
    return url.origin === globalThis.location.origin ? url.href : null;
  } catch {
    return null;
  }
}

type GeometryWorkerResponse =
  | { requestId: number; ok: true; model: GeometryPreviewModel }
  | { requestId: number; ok: false; error: string };

async function fetchBoundedBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    headers: { accept: "text/plain,application/octet-stream;q=0.8" },
    signal,
  });
  if (!response.ok) throw new Error(`Geometry content request failed (${response.status}).`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES) {
    throw new Error(`Geometry content exceeds the ${fmtBytes(SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES)} client preview cap.`);
  }
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES) {
      throw new Error(`Geometry content exceeds the ${fmtBytes(SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES)} client preview cap.`);
    }
    return bytes;
  }
  const reader = response.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES) {
        await reader.cancel();
        throw new Error(`Geometry content exceeds the ${fmtBytes(SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES)} client preview cap.`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes.buffer;
  } finally {
    reader.releaseLock();
  }
}

function parseGeometryInWorker(
  worker: Worker,
  bytes: ArrayBuffer,
  formatHint: string,
  signal: AbortSignal,
): Promise<GeometryPreviewModel> {
  const requestId = 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error("Geometry preview cancelled.")));
    const timeout = setTimeout(() => {
      finish(() => reject(new Error("Geometry parser exceeded its 15 second execution limit.")));
    }, 15_000);
    worker.onmessage = (event: MessageEvent<GeometryWorkerResponse>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId) return;
      if (message.ok) finish(() => resolve(message.model));
      else finish(() => reject(new Error(message.error)));
    };
    worker.onerror = () => {
      finish(() => reject(new Error("The isolated geometry parser failed.")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    worker.postMessage({ requestId, bytes, formatHint }, [bytes]);
  });
}

export function ScienceViewport(props: {
  artifact: ScienceArtifact | null;
  run: ScienceRun | null;
  session: ScienceRenderSession | null;
  eligibleRenderOutputs: ScienceRunArtifactRef[];
  selectedRenderOutputId: string | null;
  onRenderOutputChange: (artifactVersionId: string) => void;
  mode: ScienceFallbackMode;
  onModeChange: (mode: ScienceFallbackMode) => void;
  canBuild: boolean;
  newWorkEnabled: boolean;
  busy: boolean;
  onStartSession: () => void;
  onCloseSession: () => void;
}) {
  const [palette, setPalette] = useState<SciencePalette>("cividis");
  const [loadedVersionId, setLoadedVersionId] = useState<string | null>(null);
  const [failedVersionId, setFailedVersionId] = useState<string | null>(null);
  const [geometry, setGeometry] = useState<{
    versionId: string;
    state: "loading" | "ready" | "error";
    model?: GeometryPreviewModel;
    error?: string;
  } | null>(null);
  const geometryAbort = useRef<AbortController | null>(null);
  const geometryWorker = useRef<Worker | null>(null);
  const version = props.artifact?.latestVersion ?? null;
  const mediaType = version?.mediaType?.trim().toLowerCase() ?? "";
  const declaredImage = mediaType.startsWith("image/");
  const image = INLINE_STATIC_MEDIA_TYPES.has(mediaType);
  const format = props.artifact?.format?.trim().toUpperCase() ?? "";
  const geometryCandidate =
    props.artifact?.kind === "geometry" || ["VTK", "STL", "STEP", "STP"].includes(format);
  const staticReady = image && version?.id === loadedVersionId;
  const staticFailed = version?.id === failedVersionId;
  const geometryReady =
    geometry?.versionId === version?.id && geometry?.state === "ready" && !!geometry?.model;
  const contentUrl = version ? scienceApi.artifactContentUrl(version.id) : null;
  const renderUrl = sameOriginRenderUrl(props.session?.url);
  const staticSessionReady =
    props.session?.state === "ready" &&
    props.session.mode === "static" &&
    props.session.provider === "static" &&
    props.session.source.artifactVersionId === props.session.artifactVersionId &&
    props.session.source.mediaType.toLowerCase() === "image/png" &&
    renderUrl !== null;
  const remoteReady =
    props.session?.state === "ready" && props.session.mode === "remote" && renderUrl !== null;
  const renderUrlRejected =
    props.session?.state === "ready" && !!props.session.url && renderUrl === null;
  const hasRenderableOutput = props.eligibleRenderOutputs.length > 0;
  const rows = useMemo(
    () => props.session
      ? renderSourceRows(props.session)
      : metadataRows(props.artifact, props.run),
    [props.artifact, props.run, props.session],
  );
  const mode = props.mode === "auto"
    ? staticSessionReady ? "static" : remoteReady ? "remote" : geometryReady ? "geometry" : staticReady ? "static" : "table"
    : props.mode;
  const paletteApplies = mode === "geometry";
  const metadata = props.session ? {} : version?.metadata ?? {};
  const legend = {
    field: typeof metadata.field === "string" ? metadata.field : "N/A",
    units: typeof metadata.units === "string" ? metadata.units : "N/A",
    range: metadata.range === undefined ? "N/A" : typeof metadata.range === "string" ? metadata.range : JSON.stringify(metadata.range),
    missing: metadata.missingValue === undefined ? "N/A" : String(metadata.missingValue),
  };

  useEffect(() => {
    geometryAbort.current?.abort();
    geometryAbort.current = null;
    geometryWorker.current?.terminate();
    geometryWorker.current = null;
    setGeometry(null);
    return () => {
      geometryAbort.current?.abort();
      geometryWorker.current?.terminate();
    };
  }, [version?.id]);

  const disposeGeometry = () => {
    geometryAbort.current?.abort();
    geometryAbort.current = null;
    geometryWorker.current?.terminate();
    geometryWorker.current = null;
    setGeometry(null);
    props.onModeChange("table");
  };

  const loadGeometry = async () => {
    if (!version || !contentUrl || !geometryCandidate) return;
    geometryAbort.current?.abort();
    geometryWorker.current?.terminate();
    geometryWorker.current = null;
    const controller = new AbortController();
    geometryAbort.current = controller;
    setGeometry({ versionId: version.id, state: "loading" });
    let worker: Worker | null = null;
    try {
      const bytes = await fetchBoundedBytes(contentUrl, controller.signal);
      if (controller.signal.aborted) return;
      worker = new Worker(
        new URL("./geometry-preview.worker.ts", import.meta.url),
        { type: "module", name: "science-geometry-preview" },
      );
      geometryWorker.current = worker;
      const model = await parseGeometryInWorker(worker, bytes, format, controller.signal);
      if (controller.signal.aborted) return;
      setGeometry({ versionId: version.id, state: "ready", model });
      props.onModeChange("auto");
    } catch (error) {
      if (controller.signal.aborted) return;
      setGeometry({
        versionId: version.id,
        state: "error",
        error: error instanceof Error ? error.message : "Geometry preview failed.",
      });
    } finally {
      worker?.terminate();
      if (geometryWorker.current === worker) geometryWorker.current = null;
      if (geometryAbort.current === controller) geometryAbort.current = null;
    }
  };

  return (
    <section className="sci-viewport-isolation" aria-label="Scientific analytical viewport">
      <header className="sci-viewport-toolbar">
        <span>PRIMARY VIEWPORT //</span>
        <label>
          <span>MODE</span>
          <select
            value={props.mode}
            onChange={(event) => props.onModeChange(event.target.value as ScienceFallbackMode)}
            aria-label="Viewport rendering mode"
          >
            <option value="auto">AUTO</option>
            <option value="static">STATIC IMAGE</option>
            <option value="table">STRUCTURED TABLE</option>
          </select>
        </label>
        <label>
          <span>CLIENT GEOMETRY PALETTE</span>
          <select
            value={palette}
            onChange={(event) => setPalette(event.target.value as SciencePalette)}
            disabled={!paletteApplies}
            aria-label="Client geometry palette"
            title={paletteApplies
              ? "Palette applied to the bounded client geometry diagnostic."
              : "Palette is not applied to remote, static, or tabular output."}
          >
            <option value="cividis">CIVIDIS · SEQUENTIAL / CVD SAFE</option>
            <option value="viridis">VIRIDIS · SEQUENTIAL</option>
            <option value="coolwarm">COOLWARM · DIVERGENT</option>
            <option value="grayscale">GRAYSCALE</option>
          </select>
        </label>
        {props.session && (
          <Chip tiny tone="danger" onClick={props.onCloseSession}>CLOSE RENDER</Chip>
        )}
        {image && version && !staticReady && (
          <Chip
            tiny
            onClick={() => {
              setFailedVersionId(null);
              setLoadedVersionId(version.id);
            }}
          >
            LOAD STATIC PREVIEW
          </Chip>
        )}
        {geometryCandidate && version && geometry?.state === "loading" && (
          <Chip tiny tone="danger" onClick={disposeGeometry}>
            CANCEL GEOMETRY LOAD
          </Chip>
        )}
        {geometryCandidate && version && geometry?.state !== "loading" && !geometryReady && (
          <Chip tiny onClick={loadGeometry}>
            LOAD GEOMETRY · MAX {fmtBytes(SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES)}
          </Chip>
        )}
        {geometryReady && (
          <Chip tiny tone="danger" onClick={disposeGeometry}>
            UNLOAD CLIENT PREVIEW
          </Chip>
        )}
      </header>

      <div
        className={`sci-viewport sci-palette-${palette}`}
        role="region"
        tabIndex={0}
        aria-label={`${mode} scientific viewport. Use the toolbar to select a non-WebGL fallback.`}
      >
        {mode === "remote" && props.session?.mode === "remote" && renderUrl && (
          <iframe
            src={renderUrl}
            title="Isolated remote scientific renderer"
            sandbox="allow-scripts allow-forms allow-pointer-lock"
            referrerPolicy="no-referrer"
          />
        )}
        {mode === "geometry" && geometry?.model && (
          <GeometryPreview model={geometry.model} />
        )}
        {mode === "static" && staticSessionReady && renderUrl && props.session && (
          <figure>
            <img
              src={renderUrl}
              alt={`${props.session.source.logicalName} static visualization`}
            />
            <figcaption>
              {props.session.source.logicalName} · {fmtBytes(props.session.source.sizeBytes)} · SHA {shortHash(props.session.source.sha256)}
            </figcaption>
          </figure>
        )}
        {mode === "static" && !props.session && staticReady && !staticFailed && contentUrl && (
          <figure>
            <img
              src={contentUrl}
              alt={`${props.artifact?.logicalName ?? "Scientific"} static visualization`}
              onError={() => setFailedVersionId(version?.id ?? null)}
            />
            <figcaption>
              Static artifact v{version?.version} · SHA {shortHash(version?.sha256)}
            </figcaption>
          </figure>
        )}
        {mode === "static" && props.session?.state === "starting" && (
          <div className="sci-viewport-empty">
            <span>STATIC SESSION STARTING</span>
            <p>The exact source reservation is converging. No alternate output will be selected.</p>
          </div>
        )}
        {mode === "static" && !props.session && image && !staticReady && (
          <div className="sci-viewport-empty">
            <span>STATIC CONTENT NOT LOADED</span>
            <p>Use LOAD STATIC PREVIEW to explicitly fetch this immutable artifact version.</p>
          </div>
        )}
        {mode === "static" && !props.session && staticFailed && (
          <div className="sci-viewport-empty">
            <span>STATIC PREVIEW FAILED</span>
            <p>The content request failed. Retry the explicit preview or use the structured table.</p>
            <Chip
              tiny
              onClick={() => {
                setFailedVersionId(null);
                setLoadedVersionId(version?.id ?? null);
              }}
            >
              RETRY PREVIEW
            </Chip>
          </div>
        )}
        {mode === "static" && props.session?.state === "ready" && !staticSessionReady && (
          <div className="sci-viewport-empty">
            <span>STATIC SESSION SOURCE REFUSED</span>
            <p>The session did not resolve to the exact same-origin PNG source recorded at admission.</p>
          </div>
        )}
        {mode === "static" && !props.session && !image && (
          <div className="sci-viewport-empty">
            <span>STATIC FALLBACK UNAVAILABLE</span>
            <p>
              {declaredImage
                ? "This image media type is attachment-only and is not admitted for inline preview."
                : "The selected artifact is not an image."}{" "}
              Switch to the structured table or start an authorized renderer.
            </p>
          </div>
        )}
        {mode === "table" && (props.artifact || props.run) && (
          <div
            className="sci-fallback-table-wrap"
            tabIndex={0}
            aria-label="Scrollable structured artifact and run summary"
          >
            <table className="sci-fallback-table">
              <caption>Structured non-WebGL artifact and run summary</caption>
              <tbody>
                {rows.map(([label, value]) => (
                  <tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {mode === "table" && !props.artifact && !props.run && (
          <div className="sci-viewport-empty">
            <span>NO ANALYTICAL ARTIFACT SELECTED</span>
            <p>Select an immutable artifact version or a run output. Content is never fetched automatically.</p>
          </div>
        )}
      </div>

      <footer className="sci-legend" role="region" aria-label="Scientific visualization legend">
        <span className="sci-legend-scope">
          {props.session ? "EXACT SESSION SOURCE" : "ARTIFACT METADATA"} <b>NOT PIXEL-DERIVED</b>
        </span>
        {props.session ? (
          <>
            <span>SOURCE <b>{props.session.source.logicalName}</b></span>
            <span>MEDIA <b>{props.session.source.mediaType}</b></span>
            <span>SIZE <b>{fmtBytes(props.session.source.sizeBytes)}</b></span>
            <span>SHA <b>{shortHash(props.session.source.sha256)}</b></span>
          </>
        ) : (
          <>
            <span>FIELD <b>{legend.field}</b></span>
            <span>UNITS <b>{legend.units}</b></span>
            <span>RANGE <b>{legend.range}</b></span>
            <span>MISSING <b>{legend.missing}</b></span>
          </>
        )}
        {paletteApplies ? (
          <>
            <span>CLIENT WIREFRAME MAP <b>{palette.toUpperCase()}</b></span>
            <span className="sci-palette-bar" aria-hidden="true" />
          </>
        ) : (
          <span>DISPLAY MAP <b>NOT CLAIMED FOR {mode.toUpperCase()}</b></span>
        )}
      </footer>
      {renderUrlRejected && (
        <p className="sci-error" role="alert">
          Renderer URL rejected: Science render sessions must stay on the Puppetmaster origin.
        </p>
      )}
      {geometry?.state === "error" && (
        <p className="sci-error" role="alert">{geometry.error}</p>
      )}

      {!props.session && props.canBuild && props.run && (
        <div className="sci-render-ceremony">
          <label className="sci-render-source-select">
            <span>EXACT READY PNG OUTPUT</span>
            <select
              aria-label="Exact ready PNG render output"
              value={props.selectedRenderOutputId ?? ""}
              disabled={!hasRenderableOutput || props.busy}
              onChange={(event) => props.onRenderOutputChange(event.target.value)}
            >
              {props.eligibleRenderOutputs.map((output) => (
                <option key={output.artifactVersionId} value={output.artifactVersionId}>
                  {output.logicalName ?? output.semanticRole} · {fmtBytes(output.sizeBytes)} · SHA {shortHash(output.sha256)}
                </option>
              ))}
              {!hasRenderableOutput && <option value="">NO ELIGIBLE PNG OUTPUT</option>}
            </select>
          </label>
          <HoldButton
            tiny
            disabled={!props.newWorkEnabled || props.busy || !hasRenderableOutput}
            onComplete={props.onStartSession}
            title="Hold to start a short-lived isolated render session"
          >
            HOLD TO START RENDER
          </HoldButton>
          <span>
            {hasRenderableOutput
              ? "The static session is bound to the selected immutable PNG version and checksum."
              : "No ready PNG output within the inline size cap is linked to this run; rendering is refused."}
          </span>
        </div>
      )}
    </section>
  );
}
