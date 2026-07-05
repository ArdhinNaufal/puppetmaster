import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import { Role, ROLE_RANK } from "@puppetmaster/shared";
import { authorizationUrl, exchangeCode, oidcConfig } from "./oidc.js";
import {
  appendAudit,
  countUsers,
  createSession,
  createUser,
  deleteSession,
  deleteUser,
  getMembership,
  getSessionUser,
  getUiPreferences,
  getUser,
  getUserByEmail,
  listMembers,
  removeMembership,
  saveUiPreferences,
  upsertMembership,
  type Db,
} from "@puppetmaster/db";

const scrypt = promisify(scryptCb);

const SESSION_COOKIE = "pm_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

// --- Password hashing (scrypt, no external deps) -------------------------------

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  const expectedBuf = Buffer.from(expected, "hex");
  return hash.length === expectedBuf.length && timingSafeEqual(hash, expectedBuf);
}

// --- RBAC policy (ARCHITECTURE.md §6: enforced at the gateway) -------------------
// Everything not matched below only needs an authenticated member. Reads are open
// to every role; the tiers gate mutations.

interface PolicyRule {
  methods: string[];
  path: RegExp;
  role: Role;
}

const POLICY: PolicyRule[] = [
  // Admin surface: workspace/branding + member management + audit log.
  { methods: ["PUT"], path: /^\/api\/workspace$/, role: "admin" },
  { methods: ["GET", "POST", "PUT", "DELETE"], path: /^\/api\/members(\/|$)/, role: "admin" },
  { methods: ["GET"], path: /^\/api\/audit$/, role: "admin" },
  // Stage 1 security surface: secrets and auto-approval rules are admin-only,
  // including reads (credential names and policy predicates are sensitive).
  { methods: ["GET", "PUT", "DELETE"], path: /^\/api\/credentials(\/|$)/, role: "admin" },
  { methods: ["GET", "POST", "PUT", "DELETE"], path: /^\/api\/policies(\/|$)/, role: "admin" },
  // Builder surface: authoring and operating workflows/agents, resolving approvals.
  { methods: ["POST", "PUT", "DELETE"], path: /^\/api\/workflows(\/|$)/, role: "builder" },
  // The webhook secret is sensitive: revealing it is builder+, not an open GET.
  { methods: ["GET"], path: /^\/api\/workflows\/[^/]+\/webhook$/, role: "builder" },
  { methods: ["POST"], path: /^\/api\/approvals(\/|$)/, role: "builder" },
  // Templates: browsing is open (member); instantiate/publish/delete are builder+.
  { methods: ["POST", "PUT", "DELETE"], path: /^\/api\/templates(\/|$)/, role: "builder" },
  // Agent CRUD is builder-tier, but chatting with an agent is core member UX.
  { methods: ["POST", "PUT", "DELETE"], path: /^\/api\/agents(?!\/[^/]+\/chat$)(\/|$)/, role: "builder" },
];

/** Routes reachable without a session: health, the auth handshake itself, and
 *  webhook triggers (called by external systems; per-hook secrets are a later
 *  hardening step). */
const PUBLIC: RegExp[] = [
  /^\/api\/health$/,
  /^\/api\/auth\/(status|setup|login)$/,
  /^\/api\/auth\/oidc\/(login|callback)$/,
  /^\/api\/hooks\/[^/]+$/,
];

function requiredRole(method: string, path: string): Role | null {
  for (const rule of POLICY) {
    if (rule.methods.includes(method) && rule.path.test(path)) return rule.role;
  }
  return null;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// --- Plugin ----------------------------------------------------------------------

export async function registerAuth(
  app: FastifyInstance,
  opts: { db: Db; workspaceId: string },
): Promise<void> {
  const { db, workspaceId } = opts;
  await app.register(cookie);
  app.decorateRequest("authUser", null);

  const setSessionCookie = async (reply: FastifyReply, userId: string) => {
    const token = randomBytes(32).toString("hex");
    await createSession(db, { token, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  };

  // Gateway hook: resolve the session and enforce the RBAC policy for every
  // /api route (including the WebSocket upgrade) except the public allowlist.
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split("?")[0] ?? req.url;
    if (!path.startsWith("/api")) return;
    if (PUBLIC.some((p) => p.test(path))) return;

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? await getSessionUser(db, token) : null;
    if (!session) return reply.code(401).send({ error: "authentication required" });

    const membership = await getMembership(db, session.user.id, workspaceId);
    if (!membership) return reply.code(403).send({ error: "not a member of this workspace" });
    const role = Role.catch("member").parse(membership.role);
    req.authUser = { id: session.user.id, email: session.user.email, name: session.user.name, role };

    const needed = requiredRole(req.method, path);
    if (needed && ROLE_RANK[role] < ROLE_RANK[needed]) {
      return reply.code(403).send({ error: `requires ${needed} role`, role });
    }
  });

  // --- Auth handshake -------------------------------------------------------------

  /** First-run probe: the web app shows the setup screen while no users exist. */
  app.get("/api/auth/status", async () => ({
    needsSetup: (await countUsers(db)) === 0,
    oidcEnabled: Boolean(oidcConfig()),
  }));

  // --- OIDC (authorization-code flow) ---------------------------------------------
  const OIDC_STATE_COOKIE = "pm_oidc_state";

  app.get("/api/auth/oidc/login", async (req, reply) => {
    const cfg = oidcConfig();
    if (!cfg) return reply.code(404).send({ error: "OIDC is not configured" });
    const state = randomBytes(16).toString("hex");
    reply.setCookie(OIDC_STATE_COOKIE, state, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 600,
    });
    return reply.redirect(await authorizationUrl(cfg, state));
  });

  app.get("/api/auth/oidc/callback", async (req, reply) => {
    const cfg = oidcConfig();
    if (!cfg) return reply.code(404).send({ error: "OIDC is not configured" });
    const { code, state } = req.query as { code?: string; state?: string };
    const expected = parseCookies(req.headers.cookie)[OIDC_STATE_COOKIE];
    if (!code || !state || !expected || state !== expected) {
      return reply.code(400).send({ error: "invalid OIDC state or code" });
    }
    reply.clearCookie(OIDC_STATE_COOKIE, { path: "/" });

    let claims;
    try {
      claims = await exchangeCode(cfg, code);
    } catch (err) {
      app.log.error({ err }, "OIDC callback failed");
      return reply.code(401).send({ error: "OIDC verification failed" });
    }

    // Provision on first sight; the very first user of an empty instance is owner.
    let user = await getUserByEmail(db, claims.email);
    let provisioned = false;
    if (!user) {
      const randomPw = await hashPassword(randomBytes(24).toString("hex"));
      user = await createUser(db, { email: claims.email, name: claims.name, passwordHash: randomPw });
      provisioned = true;
    }
    if (!(await getMembership(db, user.id, workspaceId))) {
      const role = (await countUsers(db)) === 1 ? "owner" : cfg.defaultRole;
      await upsertMembership(db, { userId: user.id, workspaceId, role });
    }
    await setSessionCookie(reply, user.id);
    await appendAudit(db, {
      workspaceId, actorKind: "user", actorId: user.id, actorLabel: user.email,
      action: provisioned ? "auth.oidc.provision" : "auth.oidc.login",
      detail: { sub: claims.sub },
    });
    return reply.redirect("/");
  });

  /** Create the founding owner account. Only valid while the instance has no users. */
  app.post("/api/auth/setup", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; name?: string; password?: string };
    if (!body.email?.trim() || !body.password || body.password.length < 8) {
      return reply.code(400).send({ error: "email and a password of 8+ characters are required" });
    }
    if ((await countUsers(db)) > 0) {
      return reply.code(409).send({ error: "already set up — sign in instead" });
    }
    const user = await createUser(db, {
      email: body.email.trim(),
      name: body.name?.trim() || body.email.trim(),
      passwordHash: await hashPassword(body.password),
    });
    await upsertMembership(db, { userId: user.id, workspaceId, role: "owner" });
    await setSessionCookie(reply, user.id);
    await appendAudit(db, {
      workspaceId, actorKind: "user", actorId: user.id, actorLabel: user.email,
      action: "workspace.setup", target: user.email, detail: { role: "owner" },
    });
    return reply.code(201).send({ user: { id: user.id, email: user.email, name: user.name }, role: "owner" });
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const user = body.email ? await getUserByEmail(db, body.email) : null;
    const ok = user && body.password ? await verifyPassword(body.password, user.passwordHash) : false;
    if (!user || !ok) return reply.code(401).send({ error: "invalid credentials" });
    const membership = await getMembership(db, user.id, workspaceId);
    if (!membership) return reply.code(403).send({ error: "not a member of this workspace" });
    await setSessionCookie(reply, user.id);
    await appendAudit(db, {
      workspaceId, actorKind: "user", actorId: user.id, actorLabel: user.email, action: "auth.login",
    });
    return { user: { id: user.id, email: user.email, name: user.name }, role: membership.role };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => ({
    user: { id: req.authUser!.id, email: req.authUser!.email, name: req.authUser!.name },
    role: req.authUser!.role,
    workspaceId,
  }));

  // --- Member management (admin+) ---------------------------------------------------

  app.get("/api/members", async () => listMembers(db, workspaceId));

  app.post("/api/members", async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; name?: string; password?: string; role?: string };
    if (!body.email?.trim() || !body.password || body.password.length < 8) {
      return reply.code(400).send({ error: "email and a password of 8+ characters are required" });
    }
    const role = Role.catch("member").parse(body.role ?? "member");
    // Ownership is founded at setup, never granted through the roster.
    if (role === "owner") return reply.code(400).send({ error: "cannot grant the owner role" });
    if (await getUserByEmail(db, body.email)) {
      return reply.code(409).send({ error: "a user with that email already exists" });
    }
    const user = await createUser(db, {
      email: body.email.trim(),
      name: body.name?.trim() || body.email.trim(),
      passwordHash: await hashPassword(body.password),
    });
    await upsertMembership(db, { userId: user.id, workspaceId, role });
    await appendAudit(db, {
      workspaceId, actorKind: "user", actorId: req.authUser!.id, actorLabel: req.authUser!.email,
      action: "member.create", target: user.email, detail: { role },
    });
    return reply.code(201).send({ userId: user.id, email: user.email, name: user.name, role });
  });

  app.put("/api/members/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = (req.body ?? {}) as { role?: string };
    const role = Role.safeParse(body.role);
    if (!role.success || role.data === "owner") return reply.code(400).send({ error: "invalid role" });
    const target = await getMembership(db, userId, workspaceId);
    if (!target) return reply.code(404).send({ error: "member not found" });
    if (target.role === "owner") return reply.code(400).send({ error: "the owner role cannot be changed" });
    if (userId === req.authUser!.id) return reply.code(400).send({ error: "cannot change your own role" });
    await upsertMembership(db, { userId, workspaceId, role: role.data });
    await appendAudit(db, {
      workspaceId, actorKind: "user", actorId: req.authUser!.id, actorLabel: req.authUser!.email,
      action: "member.role", target: userId, detail: { role: role.data },
    });
    return { userId, role: role.data };
  });

  app.delete("/api/members/:userId", async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const target = await getMembership(db, userId, workspaceId);
    if (!target) return reply.code(404).send({ error: "member not found" });
    if (target.role === "owner") return reply.code(400).send({ error: "the owner cannot be removed" });
    if (userId === req.authUser!.id) return reply.code(400).send({ error: "cannot remove yourself" });
    await removeMembership(db, userId, workspaceId);
    // Single-workspace deployment: removing the membership retires the account too.
    if (await getUser(db, userId)) await deleteUser(db, userId);
    await appendAudit(db, {
      workspaceId, actorKind: "user", actorId: req.authUser!.id, actorLabel: req.authUser!.email,
      action: "member.remove", target: userId,
    });
    return reply.code(204).send();
  });

  // --- Per-user UI preferences (ui_preferences: layouts/themes) ---------------------

  app.get("/api/me/preferences", async (req) => {
    const prefs = await getUiPreferences(db, req.authUser!.id, workspaceId);
    return { layout: (prefs?.layout as Record<string, unknown>) ?? {} };
  });

  app.put("/api/me/preferences", async (req) => {
    const body = (req.body ?? {}) as { layout?: Record<string, unknown> };
    const saved = await saveUiPreferences(db, {
      userId: req.authUser!.id,
      workspaceId,
      layout: body.layout && typeof body.layout === "object" ? body.layout : {},
    });
    return { layout: saved.layout };
  });
}
