import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Chip, HoldButton } from "@puppetmaster/ui";
import type { ScienceArtifact, ScienceStudy } from "../api.js";
import { fmtBytes, SCIENCE_CLIENT_HASH_MAX_BYTES, shortHash } from "./science-utils.js";

interface PageControls {
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

interface VirtualChoiceProps<T> {
  ariaLabel: string;
  items: T[];
  itemKey: (item: T) => string;
  selectedKey: string | null;
  onSelect: (item: T) => void;
  render: (item: T) => ReactNode;
  rowHeight: number;
  empty: ReactNode;
}

function VirtualChoiceList<T>(props: VirtualChoiceProps<T>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [scrollTop, setScrollTop] = useState(0);
  const height = Math.min(300, Math.max(props.rowHeight, props.items.length * props.rowHeight));
  const visibleCount = Math.ceil(height / props.rowHeight);
  const start = Math.max(0, Math.floor(scrollTop / props.rowHeight) - 2);
  const end = Math.min(props.items.length, start + visibleCount + 4);
  const visible = props.items.slice(start, end);
  const selectedIndex = props.items.findIndex((item) => props.itemKey(item) === props.selectedKey);
  const activeDescendant = selectedIndex >= start && selectedIndex < end
    ? `${listboxId}-option-${selectedIndex}`
    : undefined;

  useEffect(() => {
    if (selectedIndex < 0) return;
    const top = selectedIndex * props.rowHeight;
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + props.rowHeight > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = top - viewport.clientHeight + props.rowHeight;
    }
  }, [selectedIndex, props.rowHeight]);

  const move = (direction: -1 | 1) => {
    if (props.items.length === 0) return;
    const current = props.items.findIndex((item) => props.itemKey(item) === props.selectedKey);
    const next = current < 0
      ? direction > 0 ? 0 : props.items.length - 1
      : Math.max(0, Math.min(props.items.length - 1, current + direction));
    props.onSelect(props.items[next]!);
  };

  if (props.items.length === 0) return <div className="sci-empty-inline">{props.empty}</div>;

  return (
    <div
      ref={viewportRef}
      className="sci-virtual-list"
      style={{ height }}
      role="listbox"
      aria-label={props.ariaLabel}
      aria-activedescendant={activeDescendant}
      tabIndex={0}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") move(1);
        else if (event.key === "ArrowUp") move(-1);
        else if (event.key === "Home") props.onSelect(props.items[0]!);
        else if (event.key === "End") props.onSelect(props.items[props.items.length - 1]!);
        else return;
        event.preventDefault();
      }}
    >
      <div className="sci-virtual-spacer" style={{ height: props.items.length * props.rowHeight }}>
        {visible.map((item, offset) => {
          const key = props.itemKey(item);
          const index = start + offset;
          return (
            <button
              key={key}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={key === props.selectedKey}
              aria-posinset={index + 1}
              aria-setsize={props.items.length}
              tabIndex={-1}
              className={`sci-rail-item ${key === props.selectedKey ? "sel" : ""}`}
              style={{ height: props.rowHeight, transform: `translateY(${index * props.rowHeight}px)` }}
              onClick={() => {
                props.onSelect(item);
                viewportRef.current?.focus();
              }}
            >
              {props.render(item)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Pager(props: PageControls & { label: string }) {
  return (
    <div className="sci-pager" aria-label={`${props.label} pagination`}>
      <Chip tiny disabled={!props.hasPrevious} onClick={props.onPrevious}>‹ PREV</Chip>
      <span>{props.label}</span>
      <Chip tiny disabled={!props.hasNext} onClick={props.onNext}>NEXT ›</Chip>
    </div>
  );
}

export function ScienceRail(props: {
  studies: ScienceStudy[];
  studiesLoading: boolean;
  studiesError: string | null;
  selectedStudyId: string | null;
  onSelectStudy: (study: ScienceStudy) => void;
  studyPage: PageControls;
  artifacts: ScienceArtifact[];
  artifactsLoading: boolean;
  artifactsError: string | null;
  selectedArtifactId: string | null;
  onSelectArtifact: (artifact: ScienceArtifact) => void;
  artifactPage: PageControls;
  canBuild: boolean;
  newWorkEnabled: boolean;
  busy: boolean;
  onCreateStudy: (name: string) => void;
  onIngest: (input: { logicalName: string; kind: string; format: string; file: File }) => void;
}) {
  const [studyName, setStudyName] = useState("");
  const [logicalName, setLogicalName] = useState("");
  const [kind, setKind] = useState("dataset");
  const [format, setFormat] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const selectedStudy = useMemo(
    () => props.studies.find((study) => study.id === props.selectedStudyId) ?? null,
    [props.studies, props.selectedStudyId],
  );

  return (
    <aside className="sci-rail-panel" aria-label="Studies and scientific artifacts">
      <div className="sci-subrail">
        <div className="sci-subhead">
          <span>01 // STUDIES</span>
          {props.studiesLoading && <span className="sci-state-note">LOADING</span>}
        </div>
        {props.studiesError && <p className="sci-error" role="alert">{props.studiesError}</p>}
        <VirtualChoiceList
          ariaLabel="Scientific studies"
          items={props.studies}
          itemKey={(study) => study.id}
          selectedKey={props.selectedStudyId}
          onSelect={props.onSelectStudy}
          rowHeight={58}
          empty={props.studiesLoading ? "Loading studies…" : "No studies yet."}
          render={(study) => (
            <>
              <span className="sci-item-primary">{study.name}</span>
              <span className="sci-item-meta">{study.classification} · {study.status.toUpperCase()}</span>
            </>
          )}
        />
        <Pager label="STUDY PAGE" {...props.studyPage} />
        {props.canBuild && (
          <details className="sci-rail-action">
            <summary>＋ CREATE STUDY</summary>
            <label className="sci-field">
              <span>Study name</span>
              <input
                value={studyName}
                onChange={(event) => setStudyName(event.target.value)}
                placeholder="Measured study name"
              />
            </label>
            <HoldButton
              tiny
              disabled={!props.newWorkEnabled || props.busy || !studyName.trim()}
              onComplete={() => {
                props.onCreateStudy(studyName.trim());
                setStudyName("");
              }}
              title="Hold to create a non-regulated study"
            >
              HOLD TO CREATE
            </HoldButton>
          </details>
        )}
      </div>

      <div className="sci-subrail grow">
        <div className="sci-subhead">
          <span>02 // ARTIFACTS</span>
          <span className="sci-state-note">{selectedStudy?.name ?? "NO STUDY"}</span>
        </div>
        {props.artifactsError && <p className="sci-error" role="alert">{props.artifactsError}</p>}
        <VirtualChoiceList
          ariaLabel="Scientific artifacts"
          items={props.artifacts}
          itemKey={(artifact) => artifact.id}
          selectedKey={props.selectedArtifactId}
          onSelect={props.onSelectArtifact}
          rowHeight={78}
          empty={
            props.selectedStudyId === null
              ? "Select a study."
              : props.artifactsLoading
                ? "Loading artifacts…"
                : "No artifacts in this study."
          }
          render={(artifact) => (
            <>
              <span className="sci-item-primary">
                {artifact.logicalName}
                {artifact.latestVersion && <span className="sci-version">v{artifact.latestVersion.version}</span>}
              </span>
              <span className="sci-item-meta">{artifact.kind.toUpperCase()} · {artifact.format.toUpperCase()} · {artifact.status.toUpperCase()}</span>
              <span className="sci-item-telemetry">
                SHA {shortHash(artifact.latestVersion?.sha256, 10)} · {fmtBytes(artifact.latestVersion?.sizeBytes)}
              </span>
            </>
          )}
        />
        <Pager label="ARTIFACT PAGE" {...props.artifactPage} />
        {props.canBuild && props.selectedStudyId && (
          <details className="sci-rail-action">
            <summary>⇪ INGEST ARTIFACT</summary>
            <label className="sci-field">
              <span>Logical name</span>
              <input value={logicalName} onChange={(event) => setLogicalName(event.target.value)} />
            </label>
            <div className="sci-field-row">
              <label className="sci-field">
                <span>Kind</span>
                <select value={kind} onChange={(event) => setKind(event.target.value)}>
                  <option value="dataset">DATASET</option>
                  <option value="geometry">GEOMETRY</option>
                  <option value="notebook">NOTEBOOK</option>
                  <option value="result">RESULT</option>
                  <option value="log">LOG</option>
                  <option value="manifest">MANIFEST</option>
                  <option value="environment">ENVIRONMENT</option>
                  <option value="other">OTHER</option>
                </select>
              </label>
              <label className="sci-field">
                <span>Format</span>
                <input value={format} onChange={(event) => setFormat(event.target.value)} placeholder="VTK, HDF5, CSV…" />
              </label>
            </div>
            <label className="sci-field">
              <span>Local file · browser SHA-256 cap {fmtBytes(SCIENCE_CLIENT_HASH_MAX_BYTES)}</span>
              <input
                type="file"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  if (next && !logicalName) setLogicalName(next.name);
                  if (next && !format) setFormat(next.name.split(".").pop()?.toUpperCase() ?? "");
                }}
              />
            </label>
            {file && file.size > SCIENCE_CLIENT_HASH_MAX_BYTES && (
              <p className="sci-error" role="alert">
                This artifact exceeds the bounded browser checksum path. Use the server/S3 ingest path.
              </p>
            )}
            <HoldButton
              tiny
              disabled={
                props.busy ||
                !props.newWorkEnabled ||
                !file ||
                file.size > SCIENCE_CLIENT_HASH_MAX_BYTES ||
                !logicalName.trim() ||
                !format.trim()
              }
              onComplete={() => {
                if (!file) return;
                props.onIngest({ logicalName: logicalName.trim(), kind, format: format.trim(), file });
                setLogicalName("");
                setFormat("");
                setFile(null);
              }}
              title="Hold to create and upload this immutable artifact version"
            >
              HOLD TO INGEST
            </HoldButton>
          </details>
        )}
      </div>
    </aside>
  );
}
