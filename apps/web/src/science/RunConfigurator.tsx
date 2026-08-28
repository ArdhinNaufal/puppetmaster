import { useEffect, useMemo, useState } from "react";
import { HoldButton } from "@puppetmaster/ui";
import type {
  ScienceArtifact,
  ScienceArtifactVersion,
  ScienceComputeProfile,
  ScienceRunInput,
  ScienceStudy,
} from "../api.js";
import { fmtElapsed, randomIdempotencyKey } from "./science-utils.js";

function parseObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function defaultSemanticRole(artifact: ScienceArtifact): string {
  if (["notebook", "dataset", "geometry"].includes(artifact.kind)) return artifact.kind;
  return "input";
}

export function RunConfigurator(props: {
  study: ScienceStudy | null;
  artifacts: ScienceArtifact[];
  inspectedArtifact: ScienceArtifact | null;
  artifactVersions: ScienceArtifactVersion[];
  profiles: ScienceComputeProfile[];
  profilesLoading: boolean;
  profilesError: string | null;
  canBuild: boolean;
  newWorkEnabled: boolean;
  busy: boolean;
  onSubmit: (input: ScienceRunInput) => void;
}) {
  const availableInputs = useMemo(() => {
    const choices = new Map<
      string,
      { artifact: ScienceArtifact; version: ScienceArtifactVersion }
    >();
    for (const artifact of props.artifacts) {
      const version = artifact.latestVersion;
      if (version?.status === "ready") {
        choices.set(version.id, { artifact, version });
      }
    }
    if (props.inspectedArtifact) {
      for (const version of props.artifactVersions) {
        if (version.status === "ready") {
          choices.set(version.id, {
            artifact: props.inspectedArtifact,
            version,
          });
        }
      }
    }
    return [...choices.values()];
  }, [props.artifacts, props.artifactVersions, props.inspectedArtifact]);
  const enabledProfiles = props.profiles.filter((profile) => profile.enabled);
  const [profileId, setProfileId] = useState("");
  const [selectedInputs, setSelectedInputs] = useState<Record<
    string,
    { artifact: ScienceArtifact; version: ScienceArtifactVersion }
  >>({});
  const [inputRoles, setInputRoles] = useState<Record<string, string>>({});
  const [parameters, setParameters] = useState("{}");
  const [cpu, setCpu] = useState("");
  const [memoryMb, setMemoryMb] = useState("");
  const [gpu, setGpu] = useState("");
  const [wallTimeSec, setWallTimeSec] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabledProfiles.some((profile) => profile.id === profileId)) {
      setProfileId(enabledProfiles[0]?.id ?? "");
    }
  }, [enabledProfiles, profileId]);

  useEffect(() => {
    setSelectedInputs({});
    setInputRoles({});
  }, [props.study?.id]);

  const selectedProfile = enabledProfiles.find((profile) => profile.id === profileId) ?? null;
  const displayedInputs = useMemo(() => {
    const choices = new Map(availableInputs.map((choice) => [choice.version.id, choice]));
    for (const choice of Object.values(selectedInputs)) {
      choices.set(choice.version.id, choice);
    }
    return [...choices.values()];
  }, [availableInputs, selectedInputs]);
  const submit = () => {
    try {
      const parsedParameters = parseObject(parameters, "Parameters");
      if (!selectedProfile) throw new Error("Select an enabled compute profile.");
      if (![cpu, memoryMb, gpu, wallTimeSec].every((value) => value.trim())) {
        throw new Error("CPU, memory, GPU, and wall time are required; profile limits are ceilings, not defaults.");
      }
      const requestedResources = {
        cpuMillicores: Number(cpu) * 1_000,
        memoryMb: Number(memoryMb),
        gpuCount: Number(gpu),
        wallTimeSeconds: Number(wallTimeSec),
      };
      for (const [key, value] of Object.entries(requestedResources)) {
        const zeroAllowed = key === "gpuCount";
        if (!Number.isFinite(value) || !Number.isInteger(value) || (zeroAllowed ? value < 0 : value <= 0)) {
          throw new Error(`${key} must be ${zeroAllowed ? "a non-negative" : "a positive"} whole number.`);
        }
        const limit = selectedProfile.resourceBounds[key as keyof typeof requestedResources];
        if (value > limit) {
          throw new Error(`${key} exceeds the selected profile limit of ${limit}.`);
        }
      }
      const inputs = Object.values(selectedInputs).map(({ version }) => {
        const artifactVersionId = version.id;
        const semanticRole = inputRoles[artifactVersionId]?.trim();
        if (!semanticRole) throw new Error("Every immutable input must have a semantic role.");
        return { artifactVersionId, semanticRole };
      });
      setFormError(null);
      props.onSubmit({
        computeProfileId: profileId,
        inputs,
        parameters: parsedParameters,
        requestedResources,
        idempotencyKey: randomIdempotencyKey(),
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Run configuration is invalid.");
    }
  };

  if (!props.study) {
    return <div className="sci-config sci-empty-inline">Select a study before configuring compute.</div>;
  }
  if (!props.canBuild) {
    return (
      <div className="sci-config sci-empty-inline">
        This role can inspect runs but cannot submit compute.
      </div>
    );
  }

  return (
    <form className="sci-config" onSubmit={(event) => event.preventDefault()}>
      <div className="sci-config-head">
        <span>RUN CONFIGURATOR</span>
        <span>{props.study.status.toUpperCase()}</span>
      </div>
      {props.profilesError && <p className="sci-error" role="alert">{props.profilesError}</p>}
      <label className="sci-field">
        <span>Compute profile</span>
        <select
          value={profileId}
          onChange={(event) => setProfileId(event.target.value)}
          disabled={props.profilesLoading || enabledProfiles.length === 0}
        >
          {props.profilesLoading && <option value="">LOADING PROFILES…</option>}
          {!props.profilesLoading && enabledProfiles.length === 0 && <option value="">NO ENABLED PROFILE</option>}
          {enabledProfiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name} · {profile.providerKind}
            </option>
          ))}
        </select>
      </label>
      {selectedProfile && (
        <div className="sci-profile-readout" role="group" aria-label="Selected compute profile">
          <span>IMAGE <b>{selectedProfile.imageDigest || "N/A"}</b></span>
          <span>AVAILABILITY <b>{selectedProfile.availability?.toUpperCase() ?? "N/A"}</b></span>
          <span>
            MEASURED QUEUE <b>{selectedProfile.measuredEstimate?.queueWaitMs == null
              ? "N/A"
              : fmtElapsed(new Date(Date.now() - selectedProfile.measuredEstimate.queueWaitMs).toISOString(), new Date().toISOString())}</b>
          </span>
          <span>
            MEASURED COST <b>{selectedProfile.measuredEstimate?.cost == null
              ? "N/A"
              : `${selectedProfile.measuredEstimate.cost} ${selectedProfile.measuredEstimate.currency ?? ""}`.trim()}</b>
          </span>
          <span>
            PROFILE LIMIT <b>
              {(selectedProfile.resourceBounds.cpuMillicores / 1_000).toFixed(2)} CPU ·{" "}
              {selectedProfile.resourceBounds.memoryMb} MiB ·{" "}
              {selectedProfile.resourceBounds.gpuCount} GPU ·{" "}
              {selectedProfile.resourceBounds.wallTimeSeconds}s
            </b>
          </span>
        </div>
      )}

      <fieldset className="sci-input-set">
        <legend>Immutable input versions · selections persist across pages</legend>
        {displayedInputs.map(({ artifact, version }) => {
          const selected = version.id in selectedInputs;
          return (
            <div className="sci-input-row" key={version.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => {
                    setSelectedInputs((current) => {
                      if (event.target.checked) {
                        if (Object.keys(current).length >= 200) return current;
                        return {
                          ...current,
                          [version.id]: { artifact, version },
                        };
                      }
                      const next = { ...current };
                      delete next[version.id];
                      return next;
                    });
                    if (event.target.checked) {
                      setInputRoles((current) => ({
                        ...current,
                        [version.id]: current[version.id] ?? defaultSemanticRole(artifact),
                      }));
                    }
                  }}
                />
                <span>{artifact.logicalName} · v{version.version} · {artifact.format.toUpperCase()}</span>
              </label>
              <input
                value={inputRoles[version.id] ?? defaultSemanticRole(artifact)}
                disabled={!selected}
                aria-label={`Semantic role for ${artifact.logicalName} version ${version.version}`}
                onChange={(event) => setInputRoles((current) => ({
                  ...current,
                  [version.id]: event.target.value,
                }))}
              />
            </div>
          );
        })}
        {displayedInputs.length === 0 && (
          <span className="sci-state-note">NO READY ARTIFACT VERSIONS ON VISITED PAGES</span>
        )}
      </fieldset>

      <label className="sci-field">
        <span>Parameters (canonical JSON; include units and seeds explicitly)</span>
        <textarea
          rows={4}
          spellCheck={false}
          value={parameters}
          onChange={(event) => setParameters(event.target.value)}
        />
      </label>

      <fieldset className="sci-resource-grid">
        <legend>Requested resources — all fields required; profile values above are ceilings</legend>
        <label className="sci-field">
          <span>CPU cores</span>
          <input
            type="number"
            min="0.001"
            step="0.001"
            max={selectedProfile ? selectedProfile.resourceBounds.cpuMillicores / 1_000 : undefined}
            value={cpu}
            onChange={(event) => setCpu(event.target.value)}
          />
        </label>
        <label className="sci-field">
          <span>Memory MiB</span>
          <input
            type="number"
            min="1"
            step="1"
            max={selectedProfile?.resourceBounds.memoryMb}
            value={memoryMb}
            onChange={(event) => setMemoryMb(event.target.value)}
          />
        </label>
        <label className="sci-field">
          <span>GPU count</span>
          <input
            type="number"
            min="0"
            step="1"
            max={selectedProfile?.resourceBounds.gpuCount}
            value={gpu}
            onChange={(event) => setGpu(event.target.value)}
          />
        </label>
        <label className="sci-field">
          <span>Wall limit sec</span>
          <input
            type="number"
            min="1"
            step="1"
            max={selectedProfile?.resourceBounds.wallTimeSeconds}
            value={wallTimeSec}
            onChange={(event) => setWallTimeSec(event.target.value)}
          />
        </label>
      </fieldset>

      {formError && <p className="sci-error" role="alert">{formError}</p>}
      <div className="sci-ceremony">
        <HoldButton
          disabled={
            props.busy ||
            !props.newWorkEnabled ||
            props.study.status === "archived" ||
            !profileId ||
            Object.keys(selectedInputs).length === 0 ||
            ![cpu, memoryMb, gpu, wallTimeSec].every((value) => value.trim()) ||
            Object.keys(selectedInputs).some((id) => !inputRoles[id]?.trim())
          }
          onComplete={submit}
          title="Hold to submit billable computation for authorization"
        >
          HOLD TO SUBMIT COMPUTE
        </HoldButton>
        <span>Submission is asynchronous and may enter an authorization gate.</span>
      </div>
    </form>
  );
}
