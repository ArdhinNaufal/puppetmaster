#!/usr/bin/env node
// Live Claude Code acceptance check.
//
// This starts the real server, bootstraps an owner account, creates a project
// whose repoRef points at a locally hosted git fixture, and then drives the
// real Claude Code session API until the turn reaches a terminal state.
//
// It does not require a valid Anthropic key to prove the control plane: the
// useful property here is that the live server accepts the turn, enters the
// runtime, clones the repository, and does not wedge in queued/running state.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { DockerCommandExecutor } from "../packages/kernel/dist/workbench.js";
import { ensureDockerImage } from "./docker-image-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_PORT = Number(process.env.CLAUDE_LIVE_PORT ?? 43129);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WORKBENCH_IMAGE = process.env.WORKBENCH_IMAGE ?? "puppetmaster-workbench:spike";
const PROXY_IMAGE = process.env.WORKBENCH_EGRESS_PROXY_IMAGE ?? "puppetmaster-egress-proxy:spike";
const LIVE_PROVIDER = process.env.CLAUDE_LIVE_PROVIDER === "openai" ? "openai" : "anthropic";
const REQUIRE_SUCCESS = ["1", "true", "yes", "on"].includes(
  (process.env.CLAUDE_LIVE_REQUIRE_SUCCESS ?? "").trim().toLowerCase(),
);
// Control-plane mode must remain free even when the caller's shell happens to
// contain paid credentials. Real keys are eligible only for an explicitly
// success-required live check (the OpenAI wrapper forces that mode).
const EFFECTIVE_ANTHROPIC_KEY = REQUIRE_SUCCESS
  ? (process.env.ANTHROPIC_API_KEY ?? "").trim() || "dummy-live-key"
  : "dummy-control-plane-key";
const EFFECTIVE_OPENAI_KEY = REQUIRE_SUCCESS
  ? (process.env.OPENAI_API_KEY ?? "").trim() || "dummy-live-key"
  : "dummy-control-plane-key";
const OPENAI_MODEL = process.env.CLAUDE_CODE_OPENAI_MODEL?.trim() || "openai/gpt-5.6";
const OPENAI_ENDPOINT = process.env.OPENAI_API_BASE?.trim() || process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com";
let openaiHost = "api.openai.com";
try { openaiHost = new URL(OPENAI_ENDPOINT).hostname; } catch { /* server returns the authoritative validation error */ }

function runGit(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status === 0) return;
  throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.status}`}`);
}

function startRepoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-claude-live-"));
  const bareDir = path.join(root, "repo.git");
  const workDir = path.join(root, "work");
  fs.mkdirSync(workDir, { recursive: true });

  runGit(["init", "--bare", "repo.git"], root);
  runGit(["init"], workDir);
  runGit(["config", "user.email", "live@example.com"], workDir);
  runGit(["config", "user.name", "Live Fixture"], workDir);
  fs.writeFileSync(path.join(workDir, "README.md"), "# Live Claude fixture\n");
  fs.writeFileSync(path.join(workDir, "index.js"), "export const answer = 42;\n");
  runGit(["add", "README.md", "index.js"], workDir);
  runGit(["commit", "-m", "seed"], workDir);
  runGit(["branch", "-M", "main"], workDir);
  runGit(["remote", "add", "origin", bareDir], workDir);
  runGit(["push", "-u", "origin", "main"], workDir);
  runGit(["update-server-info"], bareDir);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://host.docker.internal");
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const file = path.resolve(root, rel || ".");
    if (!file.startsWith(root)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("repo fixture server did not expose a port"));
        return;
      }
      resolve({
        root,
        bareDir,
        server,
        url: `http://host.docker.internal:${address.port}/repo.git`,
      });
    });
  });
}

function extractCookie(setCookie) {
  if (!setCookie) return "";
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first ? first.split(";", 1)[0] : "";
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
      last = `${res.status} ${await res.text()}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server did not become healthy: ${last ?? "unknown error"}`);
}

async function fetchJson(url, init, cookie = "") {
  const headers = new Headers(init?.headers ?? {});
  headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  return { res, body };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gracefulExit = once(child, "exit").then(() => true);
  child.kill("SIGTERM");
  if (await Promise.race([
    gracefulExit,
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])) return;

  if (child.exitCode !== null || child.signalCode !== null) return;
  const forcedExit = once(child, "exit").then(() => true);
  child.kill("SIGKILL");
  const stopped = await Promise.race([
    forcedExit,
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped) throw new Error("live verifier server did not exit after SIGKILL");
}

let repoFixture;
let serverProc;
let repoServer;
let projectId;
let cleanupLogs = [];

try {
  ensureDockerImage({
    image: WORKBENCH_IMAGE,
    dockerfile: "docker/workbench.Dockerfile",
    context: ".",
    inputs: ["docker/workbench-sync.mjs"],
  });
  ensureDockerImage({
    image: PROXY_IMAGE,
    dockerfile: "docker/egress-proxy.Dockerfile",
    context: "docker",
    inputs: ["docker/egress-proxy.mjs"],
  });

  repoFixture = await startRepoFixture();
  repoServer = repoFixture.server;

  const env = {
    ...process.env,
    PORT: String(SERVER_PORT),
    HOST: "127.0.0.1",
    WORKBENCH_MODE: "docker",
    WORKBENCH_IMAGE,
    WORKBENCH_EGRESS_PROXY_IMAGE: PROXY_IMAGE,
    WORKBENCH_EGRESS_ALLOW: `host.docker.internal,api.anthropic.com,${openaiHost}`,
    ANTHROPIC_API_KEY: EFFECTIVE_ANTHROPIC_KEY,
    OPENAI_API_KEY: EFFECTIVE_OPENAI_KEY,
  };
  if (!REQUIRE_SUCCESS) {
    // A caller may have several valid Anthropic transports configured. Remove
    // every alternate credential/selector so the free control-plane check
    // cannot authenticate through an inherited token, cloud account, or
    // custom gateway while the dummy direct key is present.
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "CLOUD_ML_REGION",
      "ANTHROPIC_FOUNDRY_API_KEY",
      "ANTHROPIC_FOUNDRY_BASE_URL",
    ]) {
      delete env[name];
    }
  }
  delete env.DATABASE_URL;
  delete env.PGLITE_DATA_DIR;
  delete env.REDIS_URL;

  serverProc = spawn("node", ["apps/server/dist/main.js"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    cleanupLogs.push(text);
    process.stdout.write(text);
  });
  serverProc.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    cleanupLogs.push(text);
    process.stderr.write(text);
  });

  const exitPromise = once(serverProc, "exit");
  await Promise.race([
    waitForHealth(SERVER_URL),
    exitPromise.then(([code, signal]) => {
      throw new Error(`server exited before becoming healthy (code=${code}, signal=${signal})`);
    }),
  ]);

  const setup = await fetchJson(`${SERVER_URL}/api/auth/setup`, {
    method: "POST",
    body: JSON.stringify({
      email: "owner@example.com",
      name: "Owner",
      password: "Password123!",
    }),
  });
  assert.equal(setup.res.status, 201, `auth setup failed: ${JSON.stringify(setup.body)}`);
  const cookie = extractCookie(setup.res.headers.getSetCookie?.() ?? setup.res.headers.get("set-cookie"));
  assert.ok(cookie, "setup must return a session cookie");

  const repo = await fetchJson(`${SERVER_URL}/api/projects`, {
    method: "POST",
    body: JSON.stringify({
      name: "Live Claude Fixture",
      repoRef: repoFixture.url,
      mode: "supervised",
    }),
  }, cookie);
  assert.equal(repo.res.status, 201, `project create failed: ${JSON.stringify(repo.body)}`);
  const project = repo.body;
  assert.ok(project?.id, "project id missing");
  projectId = project.id;

  const turn = await fetchJson(`${SERVER_URL}/api/claude-code/sessions`, {
    method: "POST",
    body: JSON.stringify({
      projectId: project.id,
      prompt: "Inspect the fixture and stop after a short summary.",
      mode: "plan",
      provider: LIVE_PROVIDER,
      model: LIVE_PROVIDER === "openai" ? OPENAI_MODEL : "sonnet",
      ...(LIVE_PROVIDER === "anthropic" ? { maxTurns: 1, maxBudgetUsd: 0.01 } : {}),
      timeoutMs: 45_000,
    }),
  }, cookie);
  assert.equal(turn.res.status, 202, `Claude turn failed to queue: ${JSON.stringify(turn.body)}`);
  const session = turn.body.session;
  const run = turn.body.run;
  assert.ok(session?.id && run?.id, "queued turn must return session and run ids");

  const deadline = Date.now() + 90_000;
  let settled;
  while (Date.now() < deadline) {
    const snapshot = await fetchJson(`${SERVER_URL}/api/claude-code/sessions/${session.id}`, {}, cookie);
    assert.equal(snapshot.res.status, 200, `session lookup failed: ${JSON.stringify(snapshot.body)}`);
    const currentRun = snapshot.body.runs.find((row) => row.id === run.id);
    if (currentRun && ["succeeded", "failed", "cancelled"].includes(currentRun.status)) {
      settled = currentRun;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  assert.ok(settled, "Claude run did not reach a terminal state");
  assert.ok(["succeeded", "failed", "cancelled"].includes(settled.status), `unexpected run status ${settled.status}`);
  if (REQUIRE_SUCCESS) {
    assert.equal(settled.status, "succeeded", `live ${LIVE_PROVIDER} request did not succeed: ${settled.error ?? "unknown error"}`);
  }
  const acceptanceLabel = REQUIRE_SUCCESS ? "LIVE PROVIDER" : "DUMMY CONTROL PLANE";
  console.log(`${acceptanceLabel} ${LIVE_PROVIDER.toUpperCase()} PASS: session ${session.id} resolved as ${settled.status}${settled.error ? ` (${settled.error})` : ""}`);
} finally {
  try {
    // Stop the inline runner before removing Docker resources so it cannot
    // race cleanup by creating or reattaching a provider container.
    if (serverProc) await stopChild(serverProc);
    if (projectId) {
      const cleanupExecutor = new DockerCommandExecutor({
        image: WORKBENCH_IMAGE,
        egressProxyImage: PROXY_IMAGE,
      });
      await cleanupExecutor.destroy(projectId);
    }
  } finally {
    if (repoServer) {
      repoServer.close();
      await Promise.race([
        once(repoServer, "close"),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    if (repoFixture?.root) {
      await fsp.rm(repoFixture.root, { recursive: true, force: true });
    }
  }
}
