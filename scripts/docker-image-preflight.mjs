import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCKER_CONFIG = path.join(os.tmpdir(), "puppetmaster-docker-config");

fs.mkdirSync(DOCKER_CONFIG, { recursive: true });

function docker(args, cwd = ROOT) {
  return spawnSync("docker", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DOCKER_CONFIG },
  });
}

export function ensureDockerImage({
  image,
  dockerfile,
  context = ".",
  inputs = [],
}) {
  const fingerprint = crypto.createHash("sha256");
  for (const input of [dockerfile, ...inputs]) {
    const absolute = path.resolve(ROOT, input);
    fingerprint.update(input);
    fingerprint.update(fs.readFileSync(absolute));
  }
  const expected = fingerprint.digest("hex");
  const label = "puppetmaster.verify.source";
  const inspect = docker([
    "image",
    "inspect",
    "--format",
    `{{ index .Config.Labels "${label}" }}`,
    image,
  ]);
  if (inspect.status === 0 && inspect.stdout.trim() === expected) return;

  console.log(`== building ${image} from ${dockerfile} ==`);
  const build = docker(["build", "--label", `${label}=${expected}`, "-t", image, "-f", dockerfile, context]);
  if (build.status === 0) return;

  throw new Error(
    `docker build failed for ${image} (${dockerfile}): ${build.stderr.trim() || build.stdout.trim() || `exit ${build.status}`}`,
  );
}
