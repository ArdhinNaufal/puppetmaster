import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  appendAudit,
  createApprovalPolicy,
  deleteApprovalPolicy,
  deleteCredential,
  getApprovalPolicy,
  getCredential,
  listApprovalPolicies,
  listCredentials,
  updateApprovalPolicy,
  upsertCredential,
  type Db,
} from "@puppetmaster/db";
import { decryptSecret, encryptSecret, PolicyPredicate } from "@puppetmaster/kernel";

/**
 * Stage 1 security surface: the credentials vault and approval auto-allow
 * policies. Both are admin-tier (RBAC rules in auth.ts) — creating an
 * auto-approval rule or a secret is itself a privileged act.
 */
export function registerSecurityRoutes(
  app: FastifyInstance,
  opts: { db: Db; workspaceId: string; masterKey: string | null },
): void {
  const { db, workspaceId, masterKey } = opts;

  const userAudit = (req: { authUser: { id: string; email: string } | null }) => ({
    workspaceId,
    actorKind: "user" as const,
    actorId: req.authUser?.id ?? null,
    actorLabel: req.authUser?.email ?? "unknown",
  });

  // --- Credentials vault (G3) ---------------------------------------------------
  // Values are write-only: set/rotate/delete, never read back through the API.

  app.get("/api/credentials", async () => ({
    vaultEnabled: Boolean(masterKey),
    credentials: await listCredentials(db, workspaceId),
  }));

  app.put("/api/credentials/:name", async (req, reply) => {
    if (!masterKey) {
      return reply.code(503).send({ error: "vault disabled: set PUPPETMASTER_MASTER_KEY" });
    }
    const { name } = req.params as { name: string };
    if (!/^[\w.-]{1,128}$/.test(name)) {
      return reply.code(400).send({ error: "credential names are 1-128 chars of [A-Za-z0-9_.-]" });
    }
    const body = (req.body ?? {}) as { value?: string };
    if (typeof body.value !== "string" || body.value.length === 0) {
      return reply.code(400).send({ error: "value is required" });
    }
    const saved = await upsertCredential(db, {
      workspaceId,
      name,
      encrypted: encryptSecret(masterKey, body.value),
    });
    await appendAudit(db, {
      ...userAudit(req),
      action: saved.created ? "credential.set" : "credential.rotate",
      target: name,
    });
    return reply.code(saved.created ? 201 : 200).send({ id: saved.id, name });
  });

  app.delete("/api/credentials/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const deleted = await deleteCredential(db, workspaceId, name);
    if (!deleted) return reply.code(404).send({ error: "credential not found" });
    await appendAudit(db, { ...userAudit(req), action: "credential.delete", target: name });
    return reply.code(204).send();
  });

  // --- Approval auto-allow policies (G2) -----------------------------------------

  const PolicyBody = z.object({
    agentId: z.string().uuid().nullish(),
    tool: z.string().regex(/^[\w-]+\.([\w-]+|\*)$/, "tool must be server.tool or server.*"),
    predicates: z.array(PolicyPredicate).default([]),
    description: z.string().default(""),
  });

  app.get("/api/policies", async () => listApprovalPolicies(db, workspaceId));

  app.post("/api/policies", async (req, reply) => {
    const parsed = PolicyBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid policy", detail: parsed.error.issues });
    }
    const policy = await createApprovalPolicy(db, {
      workspaceId,
      agentId: parsed.data.agentId ?? null,
      tool: parsed.data.tool,
      predicates: parsed.data.predicates,
      description: parsed.data.description,
    });
    await appendAudit(db, {
      ...userAudit(req),
      action: "policy.create",
      target: policy.tool,
      detail: { policyId: policy.id, agentId: policy.agentId, predicates: parsed.data.predicates },
    });
    return reply.code(201).send(policy);
  });

  app.put("/api/policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await getApprovalPolicy(db, id);
    if (!existing || existing.workspaceId !== workspaceId) {
      return reply.code(404).send({ error: "policy not found" });
    }
    const body = (req.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return reply.code(400).send({ error: "enabled (boolean) is required" });
    }
    await updateApprovalPolicy(db, id, { enabled: body.enabled });
    await appendAudit(db, {
      ...userAudit(req),
      action: "policy.update",
      target: existing.tool,
      detail: { policyId: id, enabled: body.enabled },
    });
    return { ...existing, enabled: body.enabled };
  });

  app.delete("/api/policies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await getApprovalPolicy(db, id);
    if (!existing || existing.workspaceId !== workspaceId) {
      return reply.code(404).send({ error: "policy not found" });
    }
    await deleteApprovalPolicy(db, id);
    await appendAudit(db, {
      ...userAudit(req),
      action: "policy.delete",
      target: existing.tool,
      detail: { policyId: id },
    });
    return reply.code(204).send();
  });
}

/** Vault-backed lookup for `{{credential:NAME}}` refs in MCP server env. */
export function makeCredentialLookup(
  db: Db,
  workspaceId: string,
  masterKey: string | null,
): (name: string) => Promise<string | null> {
  return async (name) => {
    if (!masterKey) return null;
    const row = await getCredential(db, workspaceId, name);
    return row ? decryptSecret(masterKey, row.encrypted) : null;
  };
}
