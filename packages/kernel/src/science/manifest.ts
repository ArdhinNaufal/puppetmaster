import { createHash } from "node:crypto";
import {
  assessScienceManifest,
  canonicalScienceJson,
  type ScienceManifestAssessment,
} from "@puppetmaster/shared";

/** Deterministic JSON used for immutable manifest hashes and comparisons. */
export function canonicalJson(value: unknown): string {
  return canonicalScienceJson(value);
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export type ManifestAssessment = ScienceManifestAssessment;

/** Backwards-compatible kernel name backed by the one shared pure assessor. */
export const assessManifest = assessScienceManifest;

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
    metric: string;
    tolerance: number;
    observed: number;
    units: string;
    methodProtocolId: string;
    limitationsReason: string;
    recordId: string;
    revision: number;
    reviewerId: string;
    createdAt: string;
    recordHash: string;
  } | null;
}

/** Already-verified, separately persisted evidence supplied by ScienceService. */
export interface LinkedNumericalValidation {
  passed: boolean;
  metric: string;
  tolerance: number;
  observed: number;
  units: string;
  methodProtocolId: string;
  limitationsReason: string;
  recordId: string;
  revision: number;
  reviewerId: string;
  createdAt: string;
  recordHash: string;
}

export function compareManifests(
  left: unknown,
  right: unknown,
  linkedNumericalValidation: LinkedNumericalValidation | null = null,
): ManifestComparison {
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
  // Manifests are immutable provenance snapshots, not a mutable review store.
  // Only an explicit record whose run/hash/checksum linkage was verified by
  // ScienceService may populate numerical evidence here.
  const numericalValidation = linkedNumericalValidation;
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
