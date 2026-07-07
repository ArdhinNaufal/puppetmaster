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
//   - a vault-style secret is injected into the workbench env at spawn;
//   - HTTP(S)_PROXY point the workbench at its sidecar;
//   - an ALLOWLISTED host is reachable through the proxy (200/3xx);
//   - a NON-allowlisted host is refused by the proxy (curl fails);
//   - DIRECT egress (bypassing the proxy) is blocked by the internal network;
//   - destroy() removes the workbench, the proxy, and the network.
// Exit 0 = all hold; 1 = a failure; 3 = no Docker daemon (skip).

import { spawnSync } from "node:child_process";
import { DockerCommandExecutor } from "../packages/kernel/dist/workbench.js";

const ALLOW = "example.com"; // stable HTTPS host for the allowlist
const DENY_URL = "https://api.github.com"; // a real host deliberately OFF the allowlist
const SECRET = "s3cr3t-egress-42";

const projectId = `egress-${Date.now()}`;
const wb = new DockerCommandExecutor({
  egressAllow: [ALLOW],
  secrets: { PM_TEST_SECRET: SECRET },
});
let fails = 0;
const ok = (m) => console.log(`  ok — ${m}`);
const bad = (m) => {
  console.error(`FAIL: ${m}`);
  fails++;
};
const docker = (args) => spawnSync("docker", args, { encoding: "utf8" });

// Preflight: daemon reachable?
try {
  const probe = await wb.run({ projectId: "preflight-none", command: "true" });
  void probe;
} catch (err) {
  if (String(err).includes("ENOENT")) {
    console.error("SKIP: docker binary not found. Run on a Docker-capable host.");
    process.exit(3);
  }
  console.error(`SKIP: docker not usable (${err}). Run on a Docker-capable host.`);
  process.exit(3);
}

try {
  console.log("== ensure() brings up the workbench + egress proxy ==");
  await wb.ensure(projectId);
  (await wb.status(projectId)) === "running" ? ok("workbench running") : bad("workbench not running");
  const proxyRunning = docker(["inspect", "-f", "{{.State.Running}}", wb.proxyName(projectId)]).stdout.trim();
  proxyRunning === "true" ? ok(`proxy ${wb.proxyName(projectId)} running`) : bad("egress proxy not running");

  console.log("== vault secret injected into the workbench env ==");
  const sec = await wb.run({ projectId, command: "printenv PM_TEST_SECRET" });
  sec.stdout.trim() === SECRET ? ok("PM_TEST_SECRET present") : bad(`secret missing (got "${sec.stdout.trim()}")`);

  console.log("== HTTPS_PROXY points at the sidecar ==");
  const env = await wb.run({ projectId, command: "printenv HTTPS_PROXY" });
  env.stdout.includes(wb.proxyName(projectId)) ? ok(env.stdout.trim()) : bad(`HTTPS_PROXY wrong: "${env.stdout.trim()}"`);

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
