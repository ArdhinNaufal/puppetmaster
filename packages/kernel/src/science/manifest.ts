import { createHash } from "node:crypto";
import { ScienceManifest } from "@puppetmaster/shared";

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalize(value: unknown, seen: Set<object>): CanonicalJson {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("manifest contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("manifest contains a cycle");
    seen.add(value);
    const output = value.map((entry) => canonicalize(entry, seen));
    seen.delete(value);
    return output;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("manifest contains a cycle");
    seen.add(value);
    const output: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      if (typeof entry === "bigint" || typeof entry === "function" || typeof entry === "symbol") {
        throw new Error(`manifest field ${key} is not JSON serializable`);
      }
      output[key] = canonicalize(entry, seen);
    }
    seen.delete(value);
    return output;
  }
  throw new Error("manifest contains a value that is not JSON serializable");
}

/** Deterministic JSON used for immutable manifest hashes and comparisons. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface ManifestAssessment {
  complete: boolean;
  gaps: string[];
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
  path: string,
  gaps: string[],
): void {
  if (typeof object[key] !== "string" || !(object[key] as string).trim()) {
    gaps.push(`${path}.${key}`);
  }
}

function requiredArray(
  object: Record<string, unknown>,
  key: string,
  path: string,
  gaps: string[],
): unknown[] {
  if (!Array.isArray(object[key])) {
    gaps.push(`${path}.${key}`);
    return [];
  }
  return object[key] as unknown[];
}

/**
 * Honest completeness assessment. A successful exit is not evidence of
 * reproducibility; the exact environment, inputs, outputs, actor, approval
 * context, and validation limitations all have to be present.
 */
export function assessManifest(value: unknown): ManifestAssessment {
  const gaps: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { complete: false, gaps: ["manifest"] };
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) gaps.push("manifest.schemaVersion");
  requiredString(manifest, "studyId", "manifest", gaps);
  requiredString(manifest, "runId", "manifest", gaps);
  requiredString(manifest, "missionId", "manifest", gaps);
  requiredString(manifest, "finishedAt", "manifest", gaps);
  requiredString(manifest, "actorId", "manifest", gaps);
  if (!manifest.compute || typeof manifest.compute !== "object" || Array.isArray(manifest.compute)) {
    gaps.push("manifest.compute");
  } else {
    const compute = manifest.compute as Record<string, unknown>;
    requiredString(compute, "profileId", "manifest.compute", gaps);
    requiredString(compute, "providerKind", "manifest.compute", gaps);
    requiredString(compute, "imageDigest", "manifest.compute", gaps);
    requiredString(compute, "kernelName", "manifest.compute", gaps);
    requiredString(compute, "adapterVersion", "manifest.compute", gaps);
    if (!compute.resourceBounds || typeof compute.resourceBounds !== "object") {
      gaps.push("manifest.compute.resourceBounds");
    }
    if (!compute.requestedResources || typeof compute.requestedResources !== "object") {
      gaps.push("manifest.compute.requestedResources");
    }
    if (!compute.dependencyLock || typeof compute.dependencyLock !== "object") {
      gaps.push("manifest.compute.dependencyLock");
    } else if (Object.keys(compute.dependencyLock as Record<string, unknown>).length === 0) {
      gaps.push("manifest.compute.dependencyLock");
    }
  }
  if (!manifest.parameters || typeof manifest.parameters !== "object") gaps.push("manifest.parameters");
  const approvals = Array.isArray(manifest.approvalIds) ? manifest.approvalIds : [];
  const policies = Array.isArray(manifest.policyIds) ? manifest.policyIds : [];
  if (approvals.length === 0 && policies.length === 0) {
    gaps.push("manifest.approvalIds|policyIds");
  }
  if (!Array.isArray(manifest.validations) || manifest.validations.length === 0) {
    gaps.push("manifest.validations");
  }
  if (!Array.isArray(manifest.limitations)) gaps.push("manifest.limitations");

  const inputs = requiredArray(manifest, "inputs", "manifest", gaps);
  const outputs = requiredArray(manifest, "outputs", "manifest", gaps);
  if (inputs.length === 0) gaps.push("manifest.inputs[0]");
  if (outputs.length === 0) gaps.push("manifest.outputs[0]");
  if (
    (typeof manifest.codeArtifactVersionId !== "string" || !manifest.codeArtifactVersionId) &&
    (typeof manifest.sourceRevision !== "string" || !manifest.sourceRevision)
  ) {
    gaps.push("manifest.codeArtifactVersionId|sourceRevision");
  }
  for (const [collection, rows] of [["inputs", inputs], ["outputs", outputs]] as const) {
    rows.forEach((entry, index) => {
      const path = `manifest.${collection}[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        gaps.push(path);
        return;
      }
      const artifact = entry as Record<string, unknown>;
      requiredString(artifact, "artifactVersionId", path, gaps);
      requiredString(artifact, "sha256", path, gaps);
      requiredString(artifact, "semanticRole", path, gaps);
      if (!Number.isSafeInteger(artifact.sizeBytes) || Number(artifact.sizeBytes) < 0) {
        gaps.push(`${path}.sizeBytes`);
      }
    });
  }
  const parsed = ScienceManifest.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      gaps.push(`manifest.${issue.path.join(".")}`);
    }
  }
  return { complete: gaps.length === 0, gaps: [...new Set(gaps)].sort() };
}

export interface ManifestComparison {
  sameInputs: boolean;
  sameParameters: boolean;
  sameEnvironment: boolean;
  sameOutputs: boolean;
  differences: string[];
  /** Never implies numerical equivalence without a declared validation result. */
  numericallyEquivalent: boolean | null;
  /** Bounded declared method/tolerance evidence; null means it was not assessed. */
  numericalValidation: {
    passed: boolean;
    metric: string | null;
    tolerance: number | string | Record<string, number | string> | null;
    observed: number | string | null;
    units: string | null;
  } | null;
}

function boundedValidationText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 200)
    : null;
}

function boundedValidationScalar(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return boundedValidationText(value);
}

function boundedTolerance(
  value: unknown,
): number | string | Record<string, number | string> | null {
  const scalar = boundedValidationScalar(value);
  if (scalar !== null) return scalar;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>)
    .slice(0, 20)
    .flatMap(([key, entry]) => {
      const bounded = boundedValidationScalar(entry);
      return bounded === null ? [] : [[key.slice(0, 100), bounded] as const];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function compareManifests(left: unknown, right: unknown): ManifestComparison {
  const a = (left && typeof left === "object" ? left : {}) as Record<string, unknown>;
  const b = (right && typeof right === "object" ? right : {}) as Record<string, unknown>;
  const sameInputs = canonicalJson(a.inputs ?? null) === canonicalJson(b.inputs ?? null);
  const sameParameters = canonicalJson(a.parameters ?? null) === canonicalJson(b.parameters ?? null);
  const sameEnvironment = canonicalJson({
    compute: a.compute ?? null,
    environment: a.environment ?? null,
  }) === canonicalJson({
    compute: b.compute ?? null,
    environment: b.environment ?? null,
  });
  const sameOutputs = canonicalJson(a.outputs ?? null) === canonicalJson(b.outputs ?? null);
  const differences = [
    ...(!sameInputs ? ["inputs"] : []),
    ...(!sameParameters ? ["parameters"] : []),
    ...(!sameEnvironment ? ["environment"] : []),
    ...(!sameOutputs ? ["outputs"] : []),
  ];
  // Numerical evidence must belong to the candidate (right-hand) run. A
  // baseline validation cannot establish that a later run is equivalent.
  const validation = b.validations as unknown;
  const numerical = Array.isArray(validation)
    ? validation.find((entry) =>
      entry && typeof entry === "object" &&
      (entry as Record<string, unknown>).kind === "numerical-equivalence")
    : null;
  const numericalRecord =
    numerical && typeof numerical === "object"
      ? numerical as Record<string, unknown>
      : null;
  const metric = boundedValidationText(numericalRecord?.metric);
  const tolerance = boundedTolerance(numericalRecord?.tolerance);
  const numericalValidation =
    numericalRecord &&
      typeof numericalRecord.passed === "boolean" &&
      metric !== null &&
      tolerance !== null
      ? {
          passed: numericalRecord.passed,
          metric,
          tolerance,
          observed: boundedValidationScalar(numericalRecord.observed),
          units: boundedValidationText(numericalRecord.units),
        }
      : null;
  const numericallyEquivalent = numericalValidation?.passed ?? null;
  return {
    sameInputs,
    sameParameters,
    sameEnvironment,
    sameOutputs,
    differences,
    numericallyEquivalent,
    numericalValidation,
  };
}

const SECRET_NAME = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential)/i;

export function redactEnvironment(
  environment: Record<string, string | undefined>,
  allowNames: readonly string[],
): Record<string, string> {
  const allowed = new Set(allowNames);
  const output: Record<string, string> = {};
  for (const name of [...allowed].sort()) {
    const value = environment[name];
    if (value === undefined) continue;
    output[name] = SECRET_NAME.test(name) ? "[REDACTED]" : value;
  }
  return output;
}
