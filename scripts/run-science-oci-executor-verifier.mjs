#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(
  new URL("./verify-science-oci-executor.py", import.meta.url),
);
const candidates = [];

if (process.env.PUPPETMASTER_PYTHON) {
  candidates.push([process.env.PUPPETMASTER_PYTHON]);
}
if (process.platform === "win32") {
  // Codex's bundled runtime is an optional local fallback, not a repository
  // dependency. Ordinary installations continue to the Python launcher/PATH.
  candidates.push([
    join(
      homedir(),
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "python",
      "python.exe",
    ),
  ]);
  candidates.push(["py", "-3"]);
  candidates.push(["python"]);
} else {
  candidates.push(["python3"]);
  candidates.push(["python"]);
}

for (const [command, ...prefix] of candidates) {
  const result = spawnSync(command, [...prefix, script], {
    cwd: repository,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(result.error.code)) {
      continue;
    }
    throw result.error;
  }
  process.exit(result.status ?? 1);
}

throw new Error(
  "Python 3 is required; set PUPPETMASTER_PYTHON to an absolute interpreter path.",
);
