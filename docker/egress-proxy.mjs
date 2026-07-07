// Egress allowlist proxy — the per-workbench sidecar of ADR-005 (WP3b.5).
//
// The workbench container has no direct route to the internet (it sits on a
// Docker `--internal` network); its only path out is this proxy. The proxy
// forwards a request ONLY when the target host is on the allowlist, so egress
// is default-closed and every reachable host is declared. HTTPS is tunnelled
// via CONNECT (the proxy never terminates TLS — it allowlists by SNI-less
// CONNECT target host and pipes bytes); plain HTTP is forwarded.
//
// Dependency-free (node stdlib only) so the image stays pinned and auditable.
// Allowlist from EGRESS_ALLOW (comma-separated hostnames; a subdomain of an
// entry matches, same rule as the kernel's HTTP_ALLOWED_HOSTS).

import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.EGRESS_PROXY_PORT ?? "8080");
const allow = (process.env.EGRESS_ALLOW ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const allowed = (host) => {
  const h = String(host ?? "").toLowerCase();
  return allow.some((entry) => h === entry || h.endsWith(`.${entry}`));
};

const log = (msg) => console.log(`[egress-proxy] ${msg}`);

// Plain HTTP: forward allowlisted requests, 403 the rest.
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400);
    return res.end("bad request");
  }
  if (!allowed(url.hostname)) {
    log(`DENY http ${url.hostname}`);
    res.writeHead(403);
    return res.end("egress denied: host not on allowlist");
  }
  const upstream = http.request(
    {
      host: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(502);
    res.end("upstream error");
  });
  req.pipe(upstream);
});

// HTTPS: allowlist the CONNECT target, then blind-tunnel bytes.
server.on("connect", (req, clientSocket, head) => {
  const idx = req.url.lastIndexOf(":");
  const host = idx > 0 ? req.url.slice(0, idx) : req.url;
  const port = idx > 0 ? Number(req.url.slice(idx + 1)) : 443;
  if (!allowed(host)) {
    log(`DENY connect ${host}`);
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\negress denied: host not on allowlist");
    return clientSocket.destroy();
  }
  const upstream = net.connect(port || 443, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => {
    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.destroy();
  });
  clientSocket.on("error", () => upstream.destroy());
});

server.listen(PORT, () => log(`listening on :${PORT} allow=[${allow.join(", ")}]`));
