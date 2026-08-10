import { resolve } from "node:path";
import {
  FilesystemArtifactStore,
  S3CompatibleArtifactStore,
  type ArtifactStore,
} from "./artifact-store.js";
import {
  ComputeProviderRegistry,
  DeterministicComputeProvider,
  HttpComputeProvider,
} from "./providers.js";
import {
  HttpRenderSessionProvider,
  RenderProviderRegistry,
  StaticRenderSessionProvider,
} from "./render.js";

export interface ScienceRuntimeConfig {
  enabled: boolean;
  submissionsEnabled: boolean;
  maxUploadBytes: number;
  maxWorkspaceStorageBytes: number;
  uploadTtlSeconds: number;
  renderTtlSeconds: number;
  maxConcurrentRunsPerWorkspace: number;
  maxConcurrentRenderSessionsPerWorkspace: number;
  pollIntervalMs: number;
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function enabled(raw: string | undefined, fallback = false): boolean {
  if (!raw?.trim()) return fallback;
  return ["1", "true", "yes", "on", "enabled"].includes(raw.trim().toLowerCase());
}

export function resolveScienceRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ScienceRuntimeConfig {
  const featureEnabled = enabled(env.SCIENCE_ENABLED);
  return {
    enabled: featureEnabled,
    submissionsEnabled:
      featureEnabled && !enabled(env.SCIENCE_READ_ONLY) && env.SCIENCE_SUBMISSIONS_DISABLED !== "1",
    maxUploadBytes: positiveInt(env, "SCIENCE_MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024, 16 * 1024 * 1024 * 1024),
    maxWorkspaceStorageBytes: positiveInt(
      env,
      "SCIENCE_MAX_WORKSPACE_STORAGE_BYTES",
      8 * 1024 * 1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    uploadTtlSeconds: positiveInt(env, "SCIENCE_UPLOAD_TTL_SECONDS", 3600, 7 * 24 * 3600),
    renderTtlSeconds: positiveInt(env, "SCIENCE_RENDER_TTL_SECONDS", 900, 24 * 3600),
    maxConcurrentRunsPerWorkspace: positiveInt(
      env,
      "SCIENCE_MAX_CONCURRENT_RUNS",
      2,
      128,
    ),
    maxConcurrentRenderSessionsPerWorkspace: positiveInt(
      env,
      "SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS",
      2,
      64,
    ),
    pollIntervalMs: positiveInt(env, "SCIENCE_POLL_INTERVAL_MS", 1_000, 60_000),
  };
}

export function createArtifactStoreFromEnv(
  env: NodeJS.ProcessEnv,
  signingSecret: string,
): ArtifactStore {
  const driver = env.SCIENCE_STORAGE_DRIVER?.trim().toLowerCase() || "filesystem";
  const providerVisibleBase = env.SCIENCE_PUBLIC_BASE_URL?.trim();
  if (
    (env.SCIENCE_RUNTIME_URL?.trim() || env.SCIENCE_RENDER_URL?.trim()) &&
    !providerVisibleBase
  ) {
    throw new Error(
      "SCIENCE_PUBLIC_BASE_URL is required when an external Science compute or render provider is configured",
    );
  }
  let publicBaseUrl = "/api/science/artifact-versions";
  if (providerVisibleBase) {
    const base = new URL(providerVisibleBase);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    ) {
      throw new Error(
        "SCIENCE_PUBLIC_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment",
      );
    }
    const directory = base.toString().replace(/\/?$/, "/");
    publicBaseUrl = new URL("api/science/artifact-versions", directory).toString().replace(/\/$/, "");
  }
  if (driver === "filesystem") {
    return new FilesystemArtifactStore({
      root: resolve(env.SCIENCE_ARTIFACT_ROOT?.trim() || "apps/server/.science-data"),
      referenceSecret: signingSecret,
      publicBaseUrl,
    });
  }
  if (driver !== "s3") throw new Error(`unsupported SCIENCE_STORAGE_DRIVER ${driver}`);
  const required = [
    "SCIENCE_S3_ENDPOINT",
    "SCIENCE_S3_BUCKET",
    "SCIENCE_S3_ACCESS_KEY_ID",
    "SCIENCE_S3_SECRET_ACCESS_KEY",
  ] as const;
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`S3 science storage is missing ${missing.join(", ")}`);
  }
  return new S3CompatibleArtifactStore({
    endpoint: env.SCIENCE_S3_ENDPOINT!,
    region: env.SCIENCE_S3_REGION,
    bucket: env.SCIENCE_S3_BUCKET!,
    accessKeyId: env.SCIENCE_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.SCIENCE_S3_SECRET_ACCESS_KEY!,
    quarantineRoot: resolve(
      env.SCIENCE_QUARANTINE_ROOT?.trim() || "apps/server/.science-quarantine",
    ),
    referenceSecret: signingSecret,
    publicBaseUrl,
    requestTimeoutMs: positiveInt(
      env,
      "SCIENCE_S3_REQUEST_TIMEOUT_MS",
      5 * 60_000,
      60 * 60_000,
    ),
  });
}

export function createComputeProvidersFromEnv(
  env: NodeJS.ProcessEnv,
): ComputeProviderRegistry {
  const registry = new ComputeProviderRegistry();
  const runtimeUrl = env.SCIENCE_RUNTIME_URL?.trim();
  if (runtimeUrl) {
    if (env.NODE_ENV === "production" && !env.SCIENCE_RUNTIME_TOKEN?.trim()) {
      throw new Error(
        "SCIENCE_RUNTIME_TOKEN is required for the production Science runtime adapter",
      );
    }
    if (
      env.NODE_ENV === "production" &&
      env.SCIENCE_RUNTIME_ADMISSION?.trim().toLowerCase() !== "approved"
    ) {
      throw new Error(
        "SCIENCE_RUNTIME_ADMISSION=approved is required for a production Science runtime",
      );
    }
    registry.register(new HttpComputeProvider({
      kind: "local_container",
      baseUrl: runtimeUrl,
      bearerToken: env.SCIENCE_RUNTIME_TOKEN,
      timeoutMs: positiveInt(env, "SCIENCE_RUNTIME_TIMEOUT_MS", 15_000, 10 * 60_000),
      requiredExecutionMode:
        env.NODE_ENV === "production" ? "isolated_oci" : undefined,
    }));
  } else if (env.NODE_ENV !== "production") {
    registry.register(new DeterministicComputeProvider({
      kind: "local_container",
      provisioningMs: positiveInt(env, "SCIENCE_FIXTURE_PROVISIONING_MS", 100, 60_000),
      runningMs: positiveInt(env, "SCIENCE_FIXTURE_RUNNING_MS", 300, 60_000),
    }));
  }
  // Jupyter Enterprise Gateway is intentionally not enabled by the presence
  // of a URL alone. Its adapter is admitted only after the live contract suite
  // has produced a go decision for the deployment.
  return registry;
}

export function createRenderProvidersFromEnv(
  env: NodeJS.ProcessEnv,
): RenderProviderRegistry {
  const registry = new RenderProviderRegistry();
  registry.register(new StaticRenderSessionProvider());
  const launcher = env.SCIENCE_RENDER_URL?.trim();
  if (launcher) {
    if (env.NODE_ENV === "production" && !env.SCIENCE_RENDER_TOKEN?.trim()) {
      throw new Error(
        "SCIENCE_RENDER_TOKEN is required for the production remote-render adapter",
      );
    }
    if (env.SCIENCE_RENDER_ADMISSION?.trim().toLowerCase() !== "approved") {
      throw new Error(
        "SCIENCE_RENDER_ADMISSION=approved is required; remote rendering remains NO-GO by default",
      );
    }
    registry.register(new HttpRenderSessionProvider({
      kind: "trame",
      baseUrl: launcher,
      bearerToken: env.SCIENCE_RENDER_TOKEN,
      timeoutMs: positiveInt(env, "SCIENCE_RENDER_TIMEOUT_MS", 15_000, 10 * 60_000),
    }));
  }
  return registry;
}
