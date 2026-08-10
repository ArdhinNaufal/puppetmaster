import { useEffect, useMemo, useState } from "react";
import { Chip, HoldButton } from "@puppetmaster/ui";
import type {
  ScienceComputeProfile,
  ScienceComputeProfileInput,
  ScienceComputeProviderKind,
  ScienceResourceRequest,
} from "../api.js";

const EMPTY_RESOURCES: ScienceResourceRequest = {
  cpuMillicores: 1000,
  memoryMb: 1024,
  gpuCount: 0,
  wallTimeSeconds: 3600,
};

function parsePositiveInt(value: string, label: string, zeroAllowed = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (zeroAllowed ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${label} must be ${zeroAllowed ? "a non-negative" : "a positive"} whole number.`);
  }
  return parsed;
}

export function ComputeProfileManager(props: {
  profiles: ScienceComputeProfile[];
  loading: boolean;
  error: string | null;
  busy: boolean;
  newWorkEnabled: boolean;
  onCreate: (input: ScienceComputeProfileInput) => void;
  onUpdate: (profileId: string, patch: Partial<ScienceComputeProfileInput>) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(props.profiles[0]?.id ?? null);
  const selected = useMemo(
    () => props.profiles.find((profile) => profile.id === selectedId) ?? null,
    [props.profiles, selectedId],
  );
  const [name, setName] = useState("");
  const [providerKind, setProviderKind] =
    useState<ScienceComputeProviderKind>("local_container");
  const [imageDigest, setImageDigest] = useState("");
  const [kernelName, setKernelName] = useState("");
  const [cpuMillicores, setCpuMillicores] = useState(String(EMPTY_RESOURCES.cpuMillicores));
  const [memoryMb, setMemoryMb] = useState(String(EMPTY_RESOURCES.memoryMb));
  const [gpuCount, setGpuCount] = useState(String(EMPTY_RESOURCES.gpuCount));
  const [wallTimeSeconds, setWallTimeSeconds] = useState(String(EMPTY_RESOURCES.wallTimeSeconds));
  const [dependencyLock, setDependencyLock] = useState("{}");
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId && !props.profiles.some((profile) => profile.id === selectedId)) {
      setSelectedId(props.profiles[0]?.id ?? null);
    }
  }, [props.profiles, selectedId]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setProviderKind(selected.providerKind);
    setImageDigest(selected.imageDigest);
    setKernelName(selected.kernelName);
    setCpuMillicores(String(selected.resourceBounds.cpuMillicores));
    setMemoryMb(String(selected.resourceBounds.memoryMb));
    setGpuCount(String(selected.resourceBounds.gpuCount));
    setWallTimeSeconds(String(selected.resourceBounds.wallTimeSeconds));
    setDependencyLock(JSON.stringify(selected.config.dependencyLock ?? {}, null, 2));
    setEnabled(selected.enabled);
    setFormError(null);
  }, [selected]);

  const resetForCreate = () => {
    setSelectedId(null);
    setName("");
    setProviderKind("local_container");
    setImageDigest("");
    setKernelName("");
    setCpuMillicores(String(EMPTY_RESOURCES.cpuMillicores));
    setMemoryMb(String(EMPTY_RESOURCES.memoryMb));
    setGpuCount(String(EMPTY_RESOURCES.gpuCount));
    setWallTimeSeconds(String(EMPTY_RESOURCES.wallTimeSeconds));
    setDependencyLock("{}");
    setEnabled(true);
    setFormError(null);
  };

  const submit = () => {
    if (!props.newWorkEnabled) return;
    try {
      if (!name.trim() || !kernelName.trim()) throw new Error("Name and kernel are required.");
      if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest.trim())) {
        throw new Error("Image digest must be an immutable lowercase sha256:<64 hex> digest.");
      }
      const lock = JSON.parse(dependencyLock) as unknown;
      if (!lock || Array.isArray(lock) || typeof lock !== "object") {
        throw new Error("Dependency lock must be a JSON object.");
      }
      if (Object.keys(lock).length === 0) {
        throw new Error("Dependency lock must contain at least one pinned dependency declaration.");
      }
      const resourceBounds: ScienceResourceRequest = {
        cpuMillicores: parsePositiveInt(cpuMillicores, "CPU millicores"),
        memoryMb: parsePositiveInt(memoryMb, "Memory"),
        gpuCount: parsePositiveInt(gpuCount, "GPU count", true),
        wallTimeSeconds: parsePositiveInt(wallTimeSeconds, "Wall time"),
      };
      const input: ScienceComputeProfileInput = {
        name: name.trim(),
        providerKind,
        imageDigest: imageDigest.trim(),
        kernelName: kernelName.trim(),
        resourceBounds,
        config: {
          ...(selected?.config ?? {}),
          dependencyLock: lock,
        },
        enabled,
      };
      setFormError(null);
      if (selected) props.onUpdate(selected.id, input);
      else props.onCreate(input);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Compute profile is invalid.");
    }
  };

  return (
    <div className="sci-profile-manager">
      <div className="sci-profile-manager-head">
        <label className="sci-field">
          <span>Profile</span>
          <select
            value={selectedId ?? ""}
            disabled={props.loading}
            onChange={(event) => {
              if (event.target.value) setSelectedId(event.target.value);
              else resetForCreate();
            }}
          >
            <option value="" disabled={!props.newWorkEnabled}>NEW PROFILE</option>
            {props.profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.enabled ? "ENABLED" : "DISABLED"}
              </option>
            ))}
          </select>
        </label>
        <Chip tiny disabled={!props.newWorkEnabled} onClick={resetForCreate}>NEW</Chip>
      </div>
      {props.error && <p className="sci-error" role="alert">{props.error}</p>}
      <fieldset
        className="sci-profile-form-grid"
        disabled={!props.newWorkEnabled || props.busy}
      >
        <label className="sci-field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="sci-field">
          <span>Provider</span>
          <select
            value={providerKind}
            onChange={(event) =>
              setProviderKind(event.target.value as ScienceComputeProviderKind)}
          >
            <option value="local_container">LOCAL CONTAINER</option>
            <option value="jupyter_enterprise_gateway">JUPYTER ENTERPRISE GATEWAY</option>
          </select>
        </label>
        <label className="sci-field wide">
          <span>Immutable image digest</span>
          <input
            spellCheck={false}
            value={imageDigest}
            onChange={(event) => setImageDigest(event.target.value)}
            placeholder="sha256:…"
          />
        </label>
        <label className="sci-field">
          <span>Kernel</span>
          <input value={kernelName} onChange={(event) => setKernelName(event.target.value)} />
        </label>
        <label className="sci-field">
          <span>CPU millicores ceiling</span>
          <input type="number" min="1" step="1" value={cpuMillicores} onChange={(event) => setCpuMillicores(event.target.value)} />
        </label>
        <label className="sci-field">
          <span>Memory MiB ceiling</span>
          <input type="number" min="1" step="1" value={memoryMb} onChange={(event) => setMemoryMb(event.target.value)} />
        </label>
        <label className="sci-field">
          <span>GPU ceiling</span>
          <input type="number" min="0" step="1" value={gpuCount} onChange={(event) => setGpuCount(event.target.value)} />
        </label>
        <label className="sci-field">
          <span>Wall seconds ceiling</span>
          <input type="number" min="1" step="1" value={wallTimeSeconds} onChange={(event) => setWallTimeSeconds(event.target.value)} />
        </label>
        <label className="sci-field wide">
          <span>Dependency lock JSON</span>
          <textarea rows={4} spellCheck={false} value={dependencyLock} onChange={(event) => setDependencyLock(event.target.value)} />
        </label>
        <label className="sci-profile-enabled">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          ENABLE PROFILE FOR NEW RUNS
        </label>
      </fieldset>
      {formError && <p className="sci-error" role="alert">{formError}</p>}
      <div className="sci-ceremony">
        <HoldButton
          tiny
          disabled={!props.newWorkEnabled || props.busy || props.loading}
          onComplete={submit}
          title={`Hold to ${selected ? "update" : "create"} this compute profile`}
        >
          HOLD TO {selected ? "UPDATE" : "CREATE"} PROFILE
        </HoldButton>
        <span>Profile ceilings constrain per-run requests. Image references must remain digest-pinned.</span>
      </div>
    </div>
  );
}
