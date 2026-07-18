#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(port, exited) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const winner = await Promise.race([
      fetch(`http://127.0.0.1:${port}/api/health`)
        .then((response) => response.ok ? "healthy" : "retry")
        .catch(() => "retry"),
      exited.then(() => "exited"),
    ]);
    if (winner === "healthy") return;
    if (winner === "exited") throw new Error("bootstrap server exited before becoming healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`bootstrap server did not listen on port ${port}`);
}

async function stopChild(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (stopped || child.exitCode !== null || child.signalCode !== null) return;
  const forced = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([
    forced,
    new Promise((_, reject) => setTimeout(() => reject(new Error("bootstrap server did not stop")), 5_000)),
  ]);
}

async function runBootstrap(envFile, explicitPort) {
  const env = { ...process.env, PUPPETMASTER_ENV_FILE: envFile };
  for (const name of ["DATABASE_URL", "PGLITE_DATA_DIR", "REDIS_URL", "WORKBENCH_MODE", "PORT", "HOST"]) {
    delete env[name];
  }
  if (explicitPort !== undefined) env.PORT = String(explicitPort);

  const child = spawn(process.execPath, ["apps/server/dist/bootstrap.js"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const exited = once(child, "exit");
  try {
    const filePort = Number(/^PORT=(\d+)$/m.exec(fs.readFileSync(envFile, "utf8"))?.[1]);
    await waitForHealth(explicitPort ?? filePort, exited);
  } catch (error) {
    if (logs) process.stderr.write(logs);
    throw error;
  } finally {
    await stopChild(child, exited);
  }
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "puppetmaster-env-bootstrap-"));
try {
  console.log("== server bootstrap loads a configured env file before main ==");
  const filePort = await reservePort();
  const file = path.join(fixture, "bootstrap.env");
  fs.writeFileSync(file, `PORT=${filePort}\nHOST=127.0.0.1\nMCP_DISABLE_BUNDLED=1\n`);
  await runBootstrap(file);

  console.log("== explicit process variables retain precedence over the env file ==");
  const ignoredFilePort = await reservePort();
  const explicitPort = await reservePort();
  fs.writeFileSync(file, `PORT=${ignoredFilePort}\nHOST=127.0.0.1\nMCP_DISABLE_BUNDLED=1\n`);
  await runBootstrap(file, explicitPort);

  console.log("ENV BOOTSTRAP PASS: configured file loading + explicit environment precedence");
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}
