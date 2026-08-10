import { z } from "zod";
import {
  ScienceResourceBounds,
} from "@puppetmaster/shared";
import type { ToolContext } from "./tools.js";
import type { BuiltinToolRegistry } from "./tools.js";
import type { ScienceService } from "./science/service.js";

const Uuid = z.string().uuid();
const RunInput = z.object({
  artifactVersionId: Uuid,
  semanticRole: z.string().trim().min(1).max(128),
}).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid science tool input: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`)
      .join("; ")}`);
  }
  return parsed.data;
}

function publicVersion<T extends {
  storageKey: string;
  metadata: Record<string, unknown>;
}>(version: T) {
  const { storageKey: _storageKey, ...safe } = version;
  return safe;
}

function publicRun<T extends {
  providerHandle: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  profileSnapshot: { config: Record<string, unknown> };
}>(run: T) {
  const {
    providerHandle: _providerHandle,
    leaseOwner: _leaseOwner,
    leaseExpiresAt: _leaseExpiresAt,
    heartbeatAt: _heartbeatAt,
    profileSnapshot,
    ...safe
  } = run;
  return {
    ...safe,
    profileSnapshot: {
      ...profileSnapshot,
      // Provider connection details are control-plane secrets. The immutable
      // scientific identity is the kind, image, kernel, and resource bounds.
      config: {},
    },
  };
}

function actorResolver(
  resolveActorId: (ctx: ToolContext) => Promise<string>,
  ctx: ToolContext,
): Promise<string> {
  return resolveActorId(ctx).then((id) => Uuid.parse(id));
}

/**
 * Bounded user-facing science tools. These call the same service as REST and
 * deliberately omit storage keys, provider handles, leases, bytes, and full
 * logs. Provider adapters remain internal.
 */
export function registerScienceTools(
  registry: BuiltinToolRegistry,
  deps: {
    service: ScienceService;
    resolveActorId: (ctx: ToolContext) => Promise<string>;
  },
): void {
  registry.register(
    "science",
    "study.list",
    "List bounded scientific-study summaries in this workspace.",
    "read_auto",
    {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "archived"] },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    async (args) => {
      const input = parse(z.object({
        status: z.enum(["active", "archived"]).optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }).strict(), args);
      return deps.service.listStudies({
        status: input.status,
        page: { offset: input.offset, limit: input.limit },
      });
    },
  );

  registry.register(
    "science",
    "artifact.inspect",
    "Inspect artifact metadata, immutable checksums, and authorized short-lived content references.",
    "read_auto",
    {
      type: "object",
      properties: {
        artifactId: { type: "string", format: "uuid" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["artifactId"],
    },
    async (args, ctx) => {
      const input = parse(z.object({
        artifactId: Uuid,
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }).strict(), args);
      const result = await deps.service.inspectArtifact({
        artifactId: input.artifactId,
        page: { offset: input.offset, limit: input.limit },
        audience: `science-tool:${ctx.missionId ?? "interactive"}`,
      });
      return {
        artifact: result.artifact,
        versions: {
          ...result.versions,
          items: result.versions.items.map((version) => {
            const { storageKey: _storageKey, ...safe } = version;
            return safe;
          }),
        },
      };
    },
  );

  registry.register(
    "science",
    "run.quote",
    "Quote declared or measured availability for an exact compute profile and resource request.",
    "read_auto",
    {
      type: "object",
      properties: {
        computeProfileId: { type: "string", format: "uuid" },
        resourceRequest: {
          type: "object",
          properties: {
            cpuMillicores: { type: "integer", minimum: 1 },
            memoryMb: { type: "integer", minimum: 1 },
            gpuCount: { type: "integer", minimum: 0 },
            wallTimeSeconds: { type: "integer", minimum: 1 },
          },
          required: ["cpuMillicores", "memoryMb", "gpuCount", "wallTimeSeconds"],
        },
      },
      required: ["computeProfileId", "resourceRequest"],
    },
    async (args) => {
      const input = parse(z.object({
        computeProfileId: Uuid,
        resourceRequest: ScienceResourceBounds,
      }).strict(), args);
      return deps.service.quote({
        computeProfileId: input.computeProfileId,
        resourceRequest: ScienceResourceBounds.parse(input.resourceRequest),
      });
    },
  );

  registry.register(
    "science",
    "run.submit",
    "Create a durable asynchronous science run and its explicit approval request.",
    "write_approved",
    {
      type: "object",
      properties: {
        studyId: { type: "string", format: "uuid" },
        computeProfileId: { type: "string", format: "uuid" },
        resourceRequest: { type: "object" },
        inputs: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            properties: {
              artifactVersionId: { type: "string", format: "uuid" },
              semanticRole: { type: "string", minLength: 1, maxLength: 128 },
            },
            required: ["artifactVersionId", "semanticRole"],
          },
        },
        parameters: { type: "object" },
        idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: [
        "studyId",
        "computeProfileId",
        "resourceRequest",
        "inputs",
        "idempotencyKey",
      ],
    },
    async (args, ctx) => {
      const input = parse(z.object({
        studyId: Uuid,
        computeProfileId: Uuid,
        resourceRequest: ScienceResourceBounds,
        inputs: z.array(RunInput).min(1).max(200),
        parameters: z.record(z.unknown()).optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
      }).strict(), args);
      const result = await deps.service.submitRun({
        ...input,
        resourceRequest: ScienceResourceBounds.parse(input.resourceRequest),
        actorId: await actorResolver(deps.resolveActorId, ctx),
      });
      return {
        run: publicRun(result.run),
        missionId: result.mission.id,
        approvalId: result.approval.id,
        created: result.created,
      };
    },
  );

  registry.register(
    "science",
    "run.status",
    "Read a science run state, bounded recent telemetry, and checksummed output metadata.",
    "read_auto",
    {
      type: "object",
      properties: {
        runId: { type: "string", format: "uuid" },
        eventLimit: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["runId"],
    },
    async (args) => {
      const input = parse(z.object({
        runId: Uuid,
        eventLimit: z.number().int().min(1).max(50).optional(),
      }).strict(), args);
      const dossier = await deps.service.getRunDossier(
        input.runId,
        input.eventLimit ?? 20,
      );
      return {
        run: publicRun(dossier.run),
        events: dossier.events,
        outputs: dossier.outputs.map((entry) => ({
          ...entry,
          version: entry.version ? publicVersion(entry.version) : null,
        })),
      };
    },
  );

  registry.register(
    "science",
    "run.cancel",
    "Request cancellation for an exact science run generation.",
    "destructive_confirmed",
    {
      type: "object",
      properties: {
        runId: { type: "string", format: "uuid" },
        expectedGeneration: { type: "integer", minimum: 0 },
      },
      required: ["runId", "expectedGeneration"],
    },
    async (args, ctx) => {
      const input = parse(z.object({
        runId: Uuid,
        expectedGeneration: z.number().int().nonnegative(),
      }).strict(), args);
      const result = await deps.service.cancelRun({
        ...input,
        actorId: await actorResolver(deps.resolveActorId, ctx),
      });
      return { accepted: result.accepted, run: publicRun(result.run) };
    },
  );

  registry.register(
    "science",
    "manifest.read",
    "Read the immutable provenance manifest and explicit completeness gaps for a science run.",
    "read_auto",
    {
      type: "object",
      properties: { runId: { type: "string", format: "uuid" } },
      required: ["runId"],
    },
    async (args) => {
      const input = parse(z.object({ runId: Uuid }).strict(), args);
      const result = await deps.service.getManifest(input.runId);
      return {
        ...result,
        manifest: result.manifest
          ? {
              ...result.manifest,
              compute: {
                ...result.manifest.compute,
                config: {},
              },
            }
          : null,
      };
    },
  );

  registry.register(
    "science",
    "render.open",
    "Open a short-lived same-origin render session for a checksummed science output.",
    "write_approved",
    {
      type: "object",
      properties: {
        runId: { type: "string", format: "uuid" },
        artifactVersionId: { type: "string", format: "uuid" },
        mode: { type: "string", enum: ["client", "remote", "static"] },
      },
      required: ["runId"],
    },
    async (args, ctx) => {
      const input = parse(z.object({
        runId: Uuid,
        artifactVersionId: Uuid.optional(),
        mode: z.enum(["client", "remote", "static"]).optional(),
      }).strict(), args);
      const rendered = await deps.service.createRender({
        ...input,
        actorId: await actorResolver(deps.resolveActorId, ctx),
      });
      return {
        renderSessionId: rendered.session.id,
        state: rendered.session.state,
        mode: rendered.mode,
        url: rendered.url,
        expiresAt: rendered.expiresAt,
      };
    },
  );
}
