import { useEffect, useState } from "react";
import { Chip, HoldButton } from "@puppetmaster/ui";
import type {
  ScienceArtifact,
  ScienceArtifactVersion,
} from "../api.js";
import {
  fmtBytes,
  SCIENCE_CLIENT_HASH_MAX_BYTES,
  shortHash,
} from "./science-utils.js";

export function ArtifactVersionControl(props: {
  artifact: ScienceArtifact | null;
  versions: ScienceArtifactVersion[];
  selectedVersion: ScienceArtifactVersion | null;
  loading: boolean;
  error: string | null;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  busy: boolean;
  canBuild: boolean;
  newWorkEnabled: boolean;
  isAdmin: boolean;
  onSelectVersion: (version: ScienceArtifactVersion) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onUploadVersion: (input: {
    file: File;
    parentVersionId: string | null;
  }) => void;
  onExpireVersion: (version: ScienceArtifactVersion) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [retentionConfirmation, setRetentionConfirmation] = useState("");

  useEffect(() => {
    setFile(null);
    setRetentionConfirmation("");
  }, [props.artifact?.id, props.selectedVersion?.id]);

  const selectedVersion =
    props.selectedVersion?.artifactId === props.artifact?.id
      ? props.selectedVersion
      : props.artifact?.latestVersion ?? null;

  if (!props.artifact) {
    return (
      <details className="sci-admin-profiles">
        <summary>IMMUTABLE VERSION CONTROL</summary>
        <div className="sci-empty-inline">Select an artifact to inspect its version history.</div>
      </details>
    );
  }

  return (
    <details className="sci-admin-profiles">
      <summary>
        IMMUTABLE VERSION CONTROL · {props.artifact.logicalName}
      </summary>
      <div className="sci-config">
        <div className="sci-config-head">
          <span>VERSION HISTORY</span>
          <span>{props.loading ? "LOADING" : `${props.versions.length} ON PAGE`}</span>
        </div>
        {props.error && <p className="sci-error" role="alert">{props.error}</p>}
        <div className="sci-input-set" role="listbox" aria-label="Artifact versions">
          {props.versions.map((version) => {
            const ready = version.status === "ready";
            return (
              <button
                key={version.id}
                type="button"
                role="option"
                aria-selected={version.id === selectedVersion?.id}
                className={`sci-input-row ${version.id === selectedVersion?.id ? "sel" : ""}`}
                disabled={!ready}
                onClick={() => props.onSelectVersion(version)}
                title={
                  ready
                    ? `Inspect immutable version ${version.version}`
                    : `Version ${version.version} is ${version.status} and cannot be selected`
                }
              >
                <span>
                  v{version.version} · {version.status.toUpperCase()} · SHA{" "}
                  {shortHash(version.sha256, 12)}
                </span>
                <span>{fmtBytes(version.sizeBytes)} · {version.mediaType}</span>
              </button>
            );
          })}
          {!props.loading && props.versions.length === 0 && (
            <span className="sci-state-note">NO IMMUTABLE VERSIONS</span>
          )}
        </div>
        <div className="sci-pager" role="group" aria-label="Artifact version pagination">
          <Chip tiny disabled={!props.hasPreviousPage} onClick={props.onPreviousPage}>
            ‹ PREV
          </Chip>
          <span>VERSION PAGE</span>
          <Chip tiny disabled={!props.hasNextPage} onClick={props.onNextPage}>
            NEXT ›
          </Chip>
        </div>


        {props.isAdmin && selectedVersion?.status === "ready" && (
          <div className="sci-rail-action sci-retention-action">
            <div className="sci-config-head">
              <span>RETENTION PURGE / ADMIN</span>
              <span>READY / UNREFERENCED ONLY</span>
            </div>
            <p className="sci-state-note">
              Physical bytes are removed only after the exact checksum is
              confirmed. Provenance links, child versions, render sessions,
              and active finalization block this operation. An immutable
              expired tombstone remains.
            </p>
            <code className="sci-retention-digest">
              {selectedVersion.sha256}
            </code>
            <label className="sci-field">
              <span>
                TYPE FULL SHA-256 TO CONFIRM v{selectedVersion.version}
              </span>
              <input
                type="text"
                value={retentionConfirmation}
                onChange={(event) =>
                  setRetentionConfirmation(event.target.value.trim().toLowerCase())}
                aria-label="Exact artifact checksum retention confirmation"
                autoComplete="off"
                spellCheck={false}
                placeholder={selectedVersion.sha256}
              />
            </label>
            <HoldButton
              tiny
              disabled={
                props.busy ||
                retentionConfirmation !== selectedVersion.sha256
              }
              onComplete={() => {
                props.onExpireVersion(selectedVersion);
                setRetentionConfirmation("");
              }}
              title="Hold to remove the exact unreferenced artifact bytes and retain a tombstone"
            >
              HOLD TO PURGE EXACT VERSION
            </HoldButton>
          </div>
        )}
        {props.canBuild && props.artifact.status === "active" && (
          <div className="sci-rail-action">
            <div className="sci-config-head">
              <span>UPLOAD NEW VERSION</span>
              <span>
                {selectedVersion
                  ? `PARENT v${selectedVersion.version}`
                  : "FIRST VERSION"}
              </span>
            </div>
            <label className="sci-field">
              <span>
                Local file · browser SHA-256 cap{" "}
                {fmtBytes(SCIENCE_CLIENT_HASH_MAX_BYTES)}
              </span>
              <input
                type="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            {file && file.size > SCIENCE_CLIENT_HASH_MAX_BYTES && (
              <p className="sci-error" role="alert">
                This version exceeds the bounded browser checksum path. Ask an operator to use the
                documented streaming REST upload contract.
              </p>
            )}
            <HoldButton
              tiny
              disabled={
                props.busy ||
                !props.newWorkEnabled ||
                !file ||
                file.size > SCIENCE_CLIENT_HASH_MAX_BYTES
              }
              onComplete={() => {
                if (!file) return;
                props.onUploadVersion({
                  file,
                  parentVersionId: selectedVersion?.id ?? null,
                });
                setFile(null);
              }}
              title="Hold to append a new immutable version to this logical artifact"
            >
              HOLD TO UPLOAD VERSION
            </HoldButton>
          </div>
        )}
      </div>
    </details>
  );
}
