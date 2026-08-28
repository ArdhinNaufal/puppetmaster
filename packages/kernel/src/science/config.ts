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
  JupyterEnterpriseGatewayPrerequisiteProvider,
  type JupyterEnterpriseGatewayPrerequisiteOptions,
} from "./jupyter-enterprise-gateway.js";
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
  externalUploadAbsoluteTimeoutMs: number;
  externalUploadIdleTimeoutMs: number;
  maxConcurrentExternalUploadStreamsPerWorkspace: number;
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

const TRUE_BOOLEAN_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_BOOLEAN_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function strictBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback = false,
): boolean {
  const normalized = env[name]?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (TRUE_BOOLEAN_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_VALUES.has(normalized)) return false;
  throw new Error(
    `${name} must be a boolean (1/0, true/false, yes/no, on/off, or enabled/disabled)`,
  );
}

function requiredUrl(raw: string, name: string, protocols: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(name + " must be a valid " + protocols.join(" or ") + " URL");
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(name + " must use " + protocols.join(" or "));
  }
  if (!parsed.hostname) throw new Error(name + " must include a hostname");
  return parsed;
}

function restrictedHttpUrl(raw: string, name: string, label: string): URL {
  const parsed = requiredUrl(raw, name, ["http:", "https:"]);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(label + " cannot contain credentials, query, or fragment");
  }
  return parsed;
}

export function resolveScienceRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ScienceRuntimeConfig {
  const featureEnabled = strictBoolean(env, "SCIENCE_ENABLED");
  // Once the feature is disabled, every other Science setting is inert. This
  // makes the deployment kill switch independent of stale optional adapter or
  // tuning values left in the environment.
  const activeEnv = featureEnabled ? env : {};
  const readOnly = featureEnabled
    ? strictBoolean(env, "SCIENCE_READ_ONLY")
    : true;
  const submissionsDisabled = featureEnabled && !readOnly
    ? strictBoolean(env, "SCIENCE_SUBMISSIONS_DISABLED")
    : true;
  const externalUploadAbsoluteTimeoutMs = positiveInt(
    activeEnv,
    "SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS",
    60 * 60_000,
    24 * 60 * 60_000,
  );
  const externalUploadIdleTimeoutMs = positiveInt(
    activeEnv,
    "SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS",
    60_000,
    60 * 60_000,
  );
  if (externalUploadIdleTimeoutMs > externalUploadAbsoluteTimeoutMs) {
    throw new Error(
      "SCIENCE_EXTERNAL_UPLOAD_IDLE_TIMEOUT_MS must be less than or equal to " +
      "SCIENCE_EXTERNAL_UPLOAD_ABSOLUTE_TIMEOUT_MS",
    );
  }
  return {
    enabled: featureEnabled,
    submissionsEnabled:
      featureEnabled && !readOnly && !submissionsDisabled,
    maxUploadBytes: positiveInt(activeEnv, "SCIENCE_MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024, 16 * 1024 * 1024 * 1024),
    maxWorkspaceStorageBytes: positiveInt(
      activeEnv,
      "SCIENCE_MAX_WORKSPACE_STORAGE_BYTES",
      8 * 1024 * 1024 * 1024,
      1024 * 1024 * 1024 * 1024,
    ),
    uploadTtlSeconds: positiveInt(activeEnv, "SCIENCE_UPLOAD_TTL_SECONDS", 3600, 7 * 24 * 3600),
    externalUploadAbsoluteTimeoutMs,
    externalUploadIdleTimeoutMs,
    maxConcurrentExternalUploadStreamsPerWorkspace: positiveInt(
      activeEnv,
      "SCIENCE_MAX_CONCURRENT_EXTERNAL_UPLOAD_STREAMS",
      4,
      128,
    ),
    renderTtlSeconds: positiveInt(activeEnv, "SCIENCE_RENDER_TTL_SECONDS", 900, 24 * 3600),
    maxConcurrentRunsPerWorkspace: positiveInt(
      activeEnv,
      "SCIENCE_MAX_CONCURRENT_RUNS",
      2,
      128,
    ),
    maxConcurrentRenderSessionsPerWorkspace: positiveInt(
      activeEnv,
      "SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS",
      2,
      64,
    ),
    pollIntervalMs: positiveInt(activeEnv, "SCIENCE_POLL_INTERVAL_MS", 1_000, 60_000),
  };
}

/**
 * Fail closed before any deployment resource is constructed. Development and
 * disabled-Science processes deliberately retain the local PGlite/filesystem/
 * inline-provider fallbacks; an enabled production deployment does not.
 *
 * This validates configuration only. Runtime health still has to prove
 * isolated_oci execution with user-code execution enabled before submit.
 */
export function assertScienceProductionDeploymentEnv(
  env: NodeJS.ProcessEnv,
): void {
  const config = resolveScienceRuntimeConfig(env);
  if (env.NODE_ENV !== "production" || !config.enabled) return;
  const requiredInfrastructure = ["DATABASE_URL", "REDIS_URL"] as const;
  const missingInfrastructure = requiredInfrastructure.filter(
    (name) => !env[name]?.trim(),
  );
  if (missingInfrastructure.length > 0) {
    throw new Error(
      `production Science requires external infrastructure: ${missingInfrastructure.join(", ")}`,
    );
  }
  requiredUrl(env.DATABASE_URL!, "DATABASE_URL", ["postgres:", "postgresql:"]);
  const redisUrl = requiredUrl(env.REDIS_URL!, "REDIS_URL", ["redis:", "rediss:"]);
  if (redisUrl.pathname.length > 1) {
    const databaseNumber = Number(redisUrl.pathname.slice(1));
    if (
      !/^\/[0-9]+$/.test(redisUrl.pathname) ||
      !Number.isSafeInteger(databaseNumber) ||
      databaseNumber < 0
    ) {
      throw new Error("REDIS_URL database path must be a nonnegative safe integer");
    }
  }

  if (env.SCIENCE_STORAGE_DRIVER?.trim().toLowerCase() !== "s3") {
    throw new Error(
      "production Science requires SCIENCE_STORAGE_DRIVER=s3; filesystem storage is development-only",
    );
  }
  const requiredStorage = [
    "SCIENCE_S3_ENDPOINT",
    "SCIENCE_S3_BUCKET",
    "SCIENCE_S3_ACCESS_KEY_ID",
    "SCIENCE_S3_SECRET_ACCESS_KEY",
  ] as const;
  const missingStorage = requiredStorage.filter((name) => !env[name]?.trim());
  if (missingStorage.length > 0) {
    throw new Error(
      `production Science S3 storage is missing ${missingStorage.join(", ")}`,
    );
  }
  restrictedHttpUrl(
    env.SCIENCE_S3_ENDPOINT!,
    "SCIENCE_S3_ENDPOINT",
    "S3 endpoint",
  );
  positiveInt(env, "SCIENCE_S3_REQUEST_TIMEOUT_MS", 5 * 60_000, 60 * 60_000);

  const signingSecret =
    env.SCIENCE_SIGNING_SECRET?.trim() || env.PUPPETMASTER_MASTER_KEY?.trim();
  if (!signingSecret || Buffer.byteLength(signingSecret, "utf8") < 16) {
    throw new Error(
      "production Science requires SCIENCE_SIGNING_SECRET or " +
        "PUPPETMASTER_MASTER_KEY of at least 16 bytes",
    );
  }

  const publicBaseUrl = env.SCIENCE_PUBLIC_BASE_URL?.trim();
  const runtimeUrl = env.SCIENCE_RUNTIME_URL?.trim();
  const renderUrl = env.SCIENCE_RENDER_URL?.trim();
  // Read-only is the rollback posture. Optional execution and interactive
  // rendering adapters are intentionally inert in this mode, so stale values
  // cannot prevent the control plane from starting for inspection/recovery.
  if (!config.submissionsEnabled) return;

  if (publicBaseUrl) {
    restrictedHttpUrl(
      publicBaseUrl,
      "SCIENCE_PUBLIC_BASE_URL",
      "SCIENCE_PUBLIC_BASE_URL",
    );
  }
  if ((runtimeUrl || renderUrl) && !publicBaseUrl) {
    throw new Error(
      "SCIENCE_PUBLIC_BASE_URL is required when an external Science compute or " +
        "render provider is configured",
    );
  }

  if (runtimeUrl) {
    restrictedHttpUrl(runtimeUrl, "SCIENCE_RUNTIME_URL", "science runtime URL");
    if (!env.SCIENCE_RUNTIME_TOKEN?.trim()) {
      throw new Error(
        "SCIENCE_RUNTIME_TOKEN is required for the production Science runtime adapter",
      );
    }
    if (env.SCIENCE_RUNTIME_ADMISSION?.trim().toLowerCase() !== "approved") {
      throw new Error(
        "SCIENCE_RUNTIME_ADMISSION=approved is required for a production Science runtime",
      );
    }
    positiveInt(env, "SCIENCE_RUNTIME_TIMEOUT_MS", 15_000, 10 * 60_000);
  }

  if (renderUrl) {
    restrictedHttpUrl(renderUrl, "SCIENCE_RENDER_URL", "render launcher URL");
    if (!env.SCIENCE_RENDER_TOKEN?.trim()) {
      throw new Error(
        "SCIENCE_RENDER_TOKEN is required for the production remote-render adapter",
      );
    }
    if (env.SCIENCE_RENDER_ADMISSION?.trim().toLowerCase() !== "approved") {
      throw new Error(
        "SCIENCE_RENDER_ADMISSION=approved is required; remote rendering remains " +
          "NO-GO by default",
      );
    }
    positiveInt(env, "SCIENCE_RENDER_TIMEOUT_MS", 15_000, 10 * 60_000);
  }

  const requiredRuntime = [
    "SCIENCE_RUNTIME_URL",
    "SCIENCE_RUNTIME_TOKEN",
    "SCIENCE_PUBLIC_BASE_URL",
  ] as const;
  const missingRuntime = requiredRuntime.filter((name) => !env[name]?.trim());
  if (missingRuntime.length > 0) {
    throw new Error(
      `writable production Science requires an admitted runtime: ${missingRuntime.join(", ")}`,
    );
  }
  if (env.SCIENCE_RUNTIME_ADMISSION?.trim().toLowerCase() !== "approved") {
    throw new Error(
      "writable production Science requires SCIENCE_RUNTIME_ADMISSION=approved",
    );
  }
}

export function createArtifactStoreFromEnv(
  env: NodeJS.ProcessEnv,
  signingSecret: string,
): ArtifactStore {
  const config = resolveScienceRuntimeConfig(env);
  const driver = config.enabled
    ? env.SCIENCE_STORAGE_DRIVER?.trim().toLowerCase() || "filesystem"
    : "filesystem";
  const providerVisibleBase = config.submissionsEnabled
    ? env.SCIENCE_PUBLIC_BASE_URL?.trim()
    : undefined;
  if (
    config.submissionsEnabled &&
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
  const config = resolveScienceRuntimeConfig(env);
  if (!config.enabled) return registry;
  const runtimeUrl = env.SCIENCE_RUNTIME_URL?.trim();
  const registerRuntime = () => {
    if (!runtimeUrl) return;
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
  };
  if (!config.submissionsEnabled) {
    // A valid admitted provider remains available for cancellation during a
    // read-only rollback. Invalid or stale optional values are ignored because
    // they cannot be used to submit work and must not defeat the rollback.
    try {
      registerRuntime();
    } catch {
      // Provider omission is visible through bootstrap/readiness provider lists.
    }
    return registry;
  }
  if (runtimeUrl) {
    registerRuntime();
  } else if (env.NODE_ENV !== "production") {
    registry.register(new DeterministicComputeProvider({
      kind: "local_container",
      provisioningMs: positiveInt(env, "SCIENCE_FIXTURE_PROVISIONING_MS", 100, 60_000),
      runningMs: positiveInt(env, "SCIENCE_FIXTURE_RUNNING_MS", 300, 60_000),
    }));
  }
  // Jupyter Enterprise Gateway is intentionally not enabled by the presence
  // of a URL alone. The exported prerequisite parser/probe is deliberately not
  // registered here: it cannot start work or materialize outputs, and its
  // health is permanently NO-GO for execution.
  return registry;
}

function parseJupyterEnterpriseGatewayKernelImages(
  raw: string,
): JupyterEnterpriseGatewayPrerequisiteOptions["allowedKernelImages"] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("SCIENCE_JEG_KERNEL_IMAGES_JSON must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SCIENCE_JEG_KERNEL_IMAGES_JSON must be a JSON object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([, image]) => typeof image !== "string")) {
    throw new Error("SCIENCE_JEG_KERNEL_IMAGES_JSON values must be strings");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Builds the read-only JEG compatibility/recovery prerequisite when explicitly
 * requested. This function never registers a ComputeProvider and accepts no
 * execution admission value. Operators can use it in a bounded verifier; the
 * production service remains NO-GO for JEG until a durable execution/output
 * bridge exists and passes its live isolation gate.
 */
export function createJupyterEnterpriseGatewayPrerequisiteFromEnv(
  env: NodeJS.ProcessEnv,
): JupyterEnterpriseGatewayPrerequisiteProvider | null {
  const config = resolveScienceRuntimeConfig(env);
  if (!config.enabled) return null;
  const baseUrl = env.SCIENCE_JEG_URL?.trim();
  if (!baseUrl) return null;
  if (env.SCIENCE_JEG_ADMISSION?.trim().toLowerCase() !== "prerequisite-only") {
    throw new Error(
      "SCIENCE_JEG_ADMISSION=prerequisite-only is required; executable JEG remains NO-GO",
    );
  }
  const authToken = env.SCIENCE_JEG_TOKEN?.trim();
  const expectedInstanceId = env.SCIENCE_JEG_INSTANCE_ID?.trim();
  const kernelImages = env.SCIENCE_JEG_KERNEL_IMAGES_JSON?.trim();
  const missing = [
    ["SCIENCE_JEG_TOKEN", authToken],
    ["SCIENCE_JEG_INSTANCE_ID", expectedInstanceId],
    ["SCIENCE_JEG_KERNEL_IMAGES_JSON", kernelImages],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`JEG prerequisite configuration is missing ${missing.join(", ")}`);
  }
  return new JupyterEnterpriseGatewayPrerequisiteProvider({
    baseUrl,
    authToken: authToken!,
    admission: "prerequisite-only",
    expectedInstanceId: expectedInstanceId!,
    allowedKernelImages: parseJupyterEnterpriseGatewayKernelImages(kernelImages!),
    timeoutMs: positiveInt(env, "SCIENCE_JEG_TIMEOUT_MS", 15_000, 10 * 60_000),
  });
}

export function createRenderProvidersFromEnv(
  env: NodeJS.ProcessEnv,
): RenderProviderRegistry {
  const registry = new RenderProviderRegistry();
  registry.register(new StaticRenderSessionProvider());
  const config = resolveScienceRuntimeConfig(env);
  if (!config.enabled) return registry;
  const launcher = env.SCIENCE_RENDER_URL?.trim();
  const registerLauncher = () => {
    if (!launcher) return;
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
  };
  if (!config.submissionsEnabled) {
    // Preserve close/revoke authority when the prior admitted provider config
    // is still valid, while treating stale optional values as inert rollback
    // residue rather than a startup failure.
    try {
      registerLauncher();
    } catch {
      // Provider omission is visible through bootstrap/readiness provider lists.
    }
    return registry;
  }
  if (launcher) {
    registerLauncher();
  }
  return registry;
}
