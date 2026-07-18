#!/usr/bin/env node
// WP3b.5 verification — drives the built DockerCommandExecutor's egress path
// against a real Docker daemon. Like verify-workbench.mjs, the eval harness
// cannot exercise containers/networks, so this is the acceptance check for the
// egress-proxy allowlist + secret injection. Run on a Docker-capable host.
//
// Build BOTH images first (the workbench image now also carries curl):
//
//   docker build -t puppetmaster-workbench:spike    -f docker/workbench.Dockerfile .
//   docker build -t puppetmaster-egress-proxy:spike -f docker/egress-proxy.Dockerfile docker
//   pnpm --filter "@puppetmaster/kernel..." build && node scripts/verify-egress.mjs
//
// Proves, end-to-end through the executor CODE:
//   - a vault-style secret is absent by default and injected only into a selected process;
//   - HTTP(S)_PROXY point the workbench at its sidecar;
//   - an ALLOWLISTED host is reachable through the proxy (200/3xx);
//   - a NON-allowlisted host is refused by the proxy (curl fails);
//   - DIRECT egress (bypassing the proxy) is blocked by the internal network;
//   - destroy() removes the workbench, the proxy, and the network.
// Exit 0 = all hold; 1 = a failure; 3 = no Docker daemon (skip).

import { spawnSync } from "node:child_process";
import { DockerCommandExecutor } from "../packages/kernel/dist/workbench.js";
import { ensureDockerImage } from "./docker-image-preflight.mjs";

// Use a stable HTTPS endpoint that is already relevant to the Node toolchain.
// Some Docker Desktop networks return an upstream 502 for one.one.one.one even
// while normal registry traffic works. Override for an air-gapped environment.
const ALLOW = process.env.EGRESS_ALLOW_HOST ?? "registry.npmjs.org";
const DENY_URL = process.env.EGRESS_DENY_URL ?? "https://api.github.com"; // OFF the allowlist
const SECRET = "s3cr3t-egress-42";
const DOCKER_BIN = process.env.DOCKER_BIN ?? "docker";
const OUTBOUND_NETWORK = process.env.WORKBENCH_EGRESS_OUTBOUND_NET ?? "bridge";

const projectId = `egress-${Date.now()}`;
const wb = new DockerCommandExecutor({
  dockerBin: DOCKER_BIN,
  egressAllow: [ALLOW],
  egressOutboundNetwork: OUTBOUND_NETWORK,
  secrets: { PM_TEST_SECRET: SECRET },
});
let fails = 0;
const ok = (m) => console.log(`  ok — ${m}`);
const bad = (m) => {
  console.error(`FAIL: ${m}`);
  fails++;
};
const docker = (args) => spawnSync(DOCKER_BIN, args, { encoding: "utf8" });

// Preflight: daemon reachable?
const daemon = docker(["info", "--format", "{{.ServerVersion}}"]);
if (daemon.error?.code === "ENOENT") {
  console.error("SKIP: docker binary not found. Run on a Docker-capable host.");
  process.exit(3);
}
if (daemon.status !== 0 || !daemon.stdout.trim()) {
  console.error(`SKIP: docker daemon not usable (${daemon.stderr.trim() || `exit ${daemon.status}`}). Run on a Docker-capable host.`);
  process.exit(3);
}

try {
  ensureDockerImage({
    image: process.env.WORKBENCH_IMAGE ?? "puppetmaster-workbench:spike",
    dockerfile: "docker/workbench.Dockerfile",
    context: ".",
    inputs: ["docker/workbench-sync.mjs"],
  });
  ensureDockerImage({
    image: process.env.WORKBENCH_EGRESS_PROXY_IMAGE ?? "puppetmaster-egress-proxy:spike",
    dockerfile: "docker/egress-proxy.Dockerfile",
    context: "docker",
    inputs: ["docker/egress-proxy.mjs"],
  });

  console.log("== unsafe same-named ordinary network is replaced by an internal boundary ==");
  const staleNetwork = docker(["network", "create", wb.networkName(projectId)]);
  if (staleNetwork.status !== 0) bad(`could not create stale network fixture: ${staleNetwork.stderr}`);

  console.log("== ensure() brings up the workbench + egress proxy ==");
  await wb.ensure(projectId);
  (await wb.status(projectId)) === "running" ? ok("workbench running") : bad("workbench not running");
  const proxyRunning = docker(["inspect", "-f", "{{.State.Running}}", wb.proxyName(projectId)]).stdout.trim();
  proxyRunning === "true" ? ok(`proxy ${wb.proxyName(projectId)} running`) : bad("egress proxy not running");
  const internal = docker(["network", "inspect", "-f", "{{.Internal}}", wb.networkName(projectId)]).stdout.trim();
  internal === "true" ? ok("same-named network reconciled to Internal=true") : bad("egress network is not internal");
  const proxyNetworks = JSON.parse(
    docker(["inspect", "-f", "{{json .NetworkSettings.Networks}}", wb.proxyName(projectId)]).stdout,
  );
  proxyNetworks[wb.networkName(projectId)] && proxyNetworks[OUTBOUND_NETWORK]
    ? ok("proxy is attached to both internal and outbound networks")
    : bad("proxy network attachments are incomplete");

  console.log("== vault secret is absent by default and injected only for a selected process ==");
  const unscoped = await wb.run({ projectId, command: "test -z \"$PM_TEST_SECRET\"" });
  unscoped.code === 0 ? ok("base container environment has no vault secret") : bad("secret leaked into container config");
  const sec = await wb.run({
    projectId,
    secretNames: ["PM_TEST_SECRET"],
    command: "printenv PM_TEST_SECRET",
  });
  sec.stdout.trim() === SECRET ? ok("PM_TEST_SECRET present only in selected exec") : bad(`secret missing (got "${sec.stdout.trim()}")`);

  console.log("== HTTPS_PROXY points at the sidecar ==");
  const env = await wb.run({ projectId, command: "printenv HTTPS_PROXY" });
  env.stdout.includes(wb.proxyName(projectId)) ? ok(env.stdout.trim()) : bad(`HTTPS_PROXY wrong: "${env.stdout.trim()}"`);

  console.log("== changed egress allowlist reconciles the existing proxy and preserves project data ==");
  await wb.run({ projectId, command: "printf retained > /workbench/.egress-volume-marker" });
  const refreshed = new DockerCommandExecutor({
    dockerBin: DOCKER_BIN,
    egressAllow: [ALLOW, "config-refresh.invalid"],
    egressOutboundNetwork: OUTBOUND_NETWORK,
    secrets: { PM_TEST_SECRET: SECRET },
  });
  await refreshed.ensure(projectId);
  const proxyAllow = docker(["exec", refreshed.proxyName(projectId), "printenv", "EGRESS_ALLOW"]).stdout.trim();
  const marker = await refreshed.run({ projectId, command: "cat /workbench/.egress-volume-marker" });
  proxyAllow.includes("config-refresh.invalid") && marker.stdout.trim() === "retained"
    ? ok("proxy recreated with current allowlist; project volume retained")
    : bad(`stale egress reconciliation failed (allow=${proxyAllow}, marker=${marker.stdout.trim()})`);

  console.log("== allowlisted host reachable THROUGH the proxy ==");
  const allowRes = await wb.run({
    projectId,
    command: `curl -sS --max-time 25 -o /dev/null -w "%{http_code}" https://${ALLOW}`,
  });
  /^[23]\d\d$/.test(allowRes.stdout.trim())
    ? ok(`https://${ALLOW} → ${allowRes.stdout.trim()}`)
    : bad(`allowlisted host not reachable (code=${allowRes.code}, http=${allowRes.stdout.trim()}, err=${allowRes.stderr.trim().slice(0, 120)})`);

  console.log("== non-allowlisted host refused by the proxy ==");
  const denyRes = await wb.run({
    projectId,
    command: `curl -sS --max-time 25 -o /dev/null -w "%{http_code}" ${DENY_URL}`,
  });
  denyRes.code !== 0 && denyRes.stdout.trim() !== "200"
    ? ok(`${DENY_URL} refused (curl exit ${denyRes.code})`)
    : bad(`non-allowlisted host was NOT refused (code=${denyRes.code}, http=${denyRes.stdout.trim()})`);

  console.log("== direct egress (bypassing the proxy) is blocked by the network ==");
  const directRes = await wb.run({
    projectId,
    command: `curl -sS --noproxy '*' --max-time 10 -o /dev/null https://${ALLOW}`,
  });
  directRes.code !== 0
    ? ok(`direct connect blocked (curl exit ${directRes.code})`)
    : bad("direct egress succeeded — the workbench has an outbound route besides the proxy");
} finally {
  console.log("== destroy() removes workbench + proxy + network ==");
  await wb.destroy(projectId);
  const wbGone = (await wb.status(projectId)) === "absent";
  const proxyGone = docker(["inspect", "-f", "{{.State.Running}}", wb.proxyName(projectId)]).status !== 0;
  const netGone = docker(["network", "inspect", wb.networkName(projectId)]).status !== 0;
  wbGone && proxyGone && netGone
    ? ok("workbench, proxy, and network removed")
    : bad(`cleanup incomplete (wbGone=${wbGone}, proxyGone=${proxyGone}, netGone=${netGone})`);
}

if (fails > 0) {
  console.error("EGRESS PROXY: FAIL");
  process.exit(1);
}
console.log("EGRESS PROXY PASS: secret-inject/proxy-env/allowlisted-ok/denied-refused/direct-blocked/destroy");
