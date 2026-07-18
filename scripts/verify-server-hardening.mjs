#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  createClaudeRunMission,
  createClaudeSession,
  createDb,
  createProject,
  ensureDefaultWorkspace,
  listAudit,
  migrate,
} from "../packages/db/dist/index.js";
import { InMemoryEventBus } from "../packages/kernel/dist/index.js";
import { startAuditProjector } from "../apps/server/dist/audit.js";

async function reservePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  socket.close();
  await once(socket, "close");
  return port;
}

async function waitForHealth(baseUrl, exited) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const winner = await Promise.race([
      fetch(`${baseUrl}/api/health`)
        .then((response) => response.ok ? "healthy" : "retry")
        .catch(() => "retry"),
      exited.then(() => "exited"),
    ]);
    if (winner === "healthy") return;
    if (winner === "exited") throw new Error("server exited before becoming healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become healthy");
}

async function fetchJson(baseUrl, path, init = {}, cookie = "") {
  const headers = new Headers(init.headers ?? {});
  headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function withServer(overrides, check) {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    MCP_DISABLE_BUNDLED: "1",
    WORKBENCH_MODE: "docker",
    WORKBENCH_EGRESS_ALLOW: "api.anthropic.com",
    OPENAI_API_KEY: "server-hardening-dummy-key",
    CLAUDE_CODE_USE_BEDROCK: "false",
    AWS_ACCESS_KEY_ID: "must-not-enable-bedrock",
    AWS_SECRET_ACCESS_KEY: "must-not-enable-bedrock",
    ...overrides,
  };
  for (const name of [
    "DATABASE_URL",
    "PGLITE_DATA_DIR",
    "REDIS_URL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_FOUNDRY_API_KEY",
  ]) {
    delete env[name];
  }
  Object.assign(env, overrides);

  let logs = "";
  const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    cwd: new URL("..", import.meta.url),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const exited = once(child, "exit");
  try {
    await waitForHealth(baseUrl, exited);
    const setup = await fetchJson(baseUrl, "/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({
        email: "owner@example.com",
        name: "Owner",
        password: "Password123!",
      }),
    });
    assert.equal(setup.response.status, 201, JSON.stringify(setup.body));
    const cookie = setup.response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    assert.ok(cookie);
    await check({ baseUrl, cookie });
  } catch (error) {
    if (logs) process.stderr.write(logs);
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

console.log("== readiness is provider-host-specific and false flags stay disabled ==");
await withServer({ OPENAI_BASE_URL: "https://api.openai.com" }, async ({ baseUrl, cookie }) => {
  const catalog = await fetchJson(baseUrl, "/api/claude-code/catalog", {}, cookie);
  assert.equal(catalog.response.status, 200);
  const providers = catalog.body.runtime.providers;
  assert.equal(providers.openai.authenticationConfigured, true);
  assert.equal(providers.openai.networkConfigured, false);
  assert.match(providers.openai.unavailableReason, /api\.openai\.com/);
  assert.equal(providers.anthropic.authenticationConfigured, false);
  assert.equal(providers.anthropic.networkConfigured, true);

  const missing = await fetchJson(baseUrl, `/api/approvals/${randomUUID()}`, {
    method: "POST",
    body: "{}",
  }, cookie);
  assert.equal(missing.response.status, 400);
  const explicit = await fetchJson(baseUrl, `/api/approvals/${randomUUID()}`, {
    method: "POST",
    body: JSON.stringify({ approved: false }),
  }, cookie);
  assert.equal(explicit.response.status, 404);
});

console.log("== malformed provider URLs are not reflected to clients ==");
const endpointSecret = "server-hardening-endpoint-secret";
await withServer({ OPENAI_BASE_URL: `not-a-url?token=${endpointSecret}` }, async ({ baseUrl, cookie }) => {
  const catalog = await fetchJson(baseUrl, "/api/claude-code/catalog", {}, cookie);
  assert.equal(catalog.response.status, 200);
  const provider = catalog.body.runtime.providers.openai;
  assert.equal(
    provider.unavailableReason,
    "OpenAI provider endpoint must be a valid HTTP(S) URL with a hostname.",
  );
  assert.doesNotMatch(JSON.stringify(provider), new RegExp(endpointSecret));
});

console.log("== OpenAI/Aider lifecycle projection uses its provider actor label ==");
const handle = await createDb({ ephemeral: true });
try {
  await migrate(handle);
  const workspaceId = await ensureDefaultWorkspace(handle.db, "Server hardening verifier");
  const project = await createProject(handle.db, { workspaceId, name: "Audit actor fixture" });
  const session = await createClaudeSession(handle.db, {
    workspaceId,
    projectId: project.id,
    title: "OpenAI audit actor",
    provider: "openai",
    backend: "aider",
    model: "openai/gpt-5.6",
    effort: null,
    permissionMode: "plan",
  });
  const turn = await createClaudeRunMission(handle.db, {
    sessionId: session.id,
    mode: "plan",
    prompt: "Audit this turn",
    model: "openai/gpt-5.6",
    effort: null,
    permissionMode: "plan",
  });
  const bus = new InMemoryEventBus();
  const stop = startAuditProjector(bus, handle.db);
  await bus.publish({ type: "mission.started", missionId: turn.mission.id, at: new Date().toISOString() });
  let projected;
  for (let attempt = 0; attempt < 50 && !projected; attempt++) {
    projected = (await listAudit(handle.db, workspaceId, { action: "mission.started" }))
      .find((entry) => entry.missionId === turn.mission.id);
    if (!projected) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  stop();
  assert.equal(projected?.actorLabel, "openai-aider");
} finally {
  await handle.close();
}

console.log("SERVER HARDENING PASS: approval validation, guarded readiness, redaction, and audit actors");
