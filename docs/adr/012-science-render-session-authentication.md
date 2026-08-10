# ADR-012: Owner-bound, expiring, same-origin render sessions

## Status

Accepted for the static fallback and render-session control contract
(2026-07-29).

The trame provider is operationally no-go. The current HTTP gateway is not a
validated trame/WebSocket reverse proxy and has no live isolation, origin,
expiry, disconnect, or cleanup evidence.

## Context

Remote scientific renderers are stateful, memory-heavy applications that may
hold a complete dataset. Exposing an upstream URL or bearer token to the browser
would bypass Puppetmaster workspace/session authorization. Treating a renderer
as a passive image is also unsafe: trame and notebook output can contain active
HTML, JavaScript, and WebSockets.

The product still needs an always-available path when WebGL or a remote renderer
is unavailable.

## Decision

Puppetmaster owns a durable `science_render_sessions` record with workspace,
owner, run/artifact target, provider handle, token hash, audience, state,
expiry, heartbeat, and persisted cleanup retry/backoff state. Admission is
serialized per workspace and bounded by
`SCIENCE_MAX_CONCURRENT_RENDER_SESSIONS` (default 2, maximum 64); any row still
holding a launch-attempt or provider handle consumes a slot.

`RenderSessionProvider` supplies `start`, `status`, `renew`, `close`, and
`health`. Every mutating/status operation receives the immutable expected
launcher instance ID; the HTTP contract carries it in
`X-Science-Provider-Instance` and rejects missing/stale fences before acting.
Provider handles are internal and encoded with their provider kind and
launcher instance; they are not returned by REST or tools.

The session flow is:

1. A builder in an admitted workspace selects a checksummed output that is
   linked to the run. Start and renew are resource-bearing and recheck the
   committed admission decision; close and reconciliation remain available
   after revocation or global read-only mode.
2. Puppetmaster creates an owner-bound session, audience, expiry, and derived
   gateway token, then persists a bounded launch-attempt marker before remote
   start.
3. The provider receives a scoped artifact reference and gateway token. The
   returned actual handle compare-and-set replaces the marker before other
   response fields are trusted; an ambiguous marker remains an administrator
   barrier and is never sent as an actual close/renew handle.
4. The browser receives only
   `/api/science/render-sessions/:id/gateway`.
5. Every gateway request rechecks the authenticated workspace and exact owner.
6. Renew extends the provider and database expiry. Close first closes the exact
   provider handle, transitions the local session terminal, then deletes the
   terminal row so it no longer retains the artifact.
7. If close fails, the row/handle remains a provenance hold and stays
   discoverable for retry.
8. Startup reconciliation expires stale sessions, retries provider cleanup for
   terminal sessions whose handles remain recorded, and re-enqueues recoverable
   database runs.
9. The bounded single-flight periodic task performs that same full
   reconciliation. Cleanup deletes terminal session metadata only after exact
   provider close succeeds and persists backoff after failure.

The always-configured `StaticRenderSessionProvider` redirects the verified
session to the normal authenticated artifact-content route. No expiring
capability URL is embedded in its durable provider handle.

The HTTP remote adapter restricts launcher and upstream URLs to the configured
origin. Its close contract accepts only 200, 204, or idempotent 404. The current
gateway supports bounded HTTP GET/range proxying, double-decodes and
canonicalizes suffixes, rejects ambiguous path components, and confines the
result to the exact upstream base-path prefix and origin. It strips redirects,
supplies the server-held bearer token, and returns `private, no-store`,
`nosniff`, and CSP with `connect-src 'self'`. The FUI accepts only same-origin
session URLs and embeds remote content in an iframe sandbox without
`allow-same-origin`.

These controls define the contract but do not admit trame. Production trame
requires a separate gateway with validated WebSocket routing, CSP/origin
policy, heartbeat/disconnect semantics, process quotas, and cleanup evidence.

## Alternatives considered

- **Expose the renderer's URL/token to the browser**: rejected because it
  bypasses workspace and owner authorization.
- **Proxy raw frames or datasets through MCP**: rejected as unbounded and
  inappropriate for the command plane.
- **Client rendering only**: rejected as a universal strategy; large or
  unsupported data needs a separate renderer or a static fallback.
- **Remote renderer only**: rejected because it removes the accessible,
  low-resource fallback.
- **Assume `trame-react` supplies security/lifecycle**: rejected. UI embedding
  does not prove token, origin, routing, quota, or cleanup behavior.

## Consequences

Positive:

- Browser-visible URLs remain on the Puppetmaster origin.
- Session ownership and expiry are checked for every gateway request.
- Static/table fallbacks remain usable without WebGL or trame.
- Failed start compensates by closing a launched provider when possible.
- Successful close removes transient session metadata and its artifact purge
  hold.
- Revocation stops future launch/renewal without hiding an existing session or
  preventing exact close; the FUI retires the current session instead of
  renewing it when admission is no longer confirmed.

Negative:

- Remote rendering requires lifecycle-aware reverse proxying, not a simple
  iframe URL.
- Local cleanup retry runs at startup and periodically, but no admitted remote
  renderer has proved process/memory reclamation under failure.
- A failed or identity-fenced close intentionally retains the session row and
  can continue to hold artifact bytes until exact cleanup is proven.
- The current HTTP gateway does not proxy WebSockets and therefore cannot be
  called a trame implementation.
- The database-backed render-session concurrency limit exists, but target
  quota/load enforcement, two-user live isolation, memory reclamation, and
  browser-disconnect behavior have no retained live evidence.

## Verification

Static ownership, renewal, close, expiry, handle bounds, and cleanup
compensation are represented by:

- `scripts/verify-science-service.mjs`
- `scripts/verify-science-routes.mjs`
- `scripts/verify-science-lifecycle.mjs`

No `verify-science-render-session` live suite currently proves trame admission.
That absence is a release gate, not a skipped optional check.
The current post-migration-11 aggregate/root rerun is also pending.

## Reconsider when

- A selected renderer has a different session/routing model.
- A measured client-rendering corpus removes the need for remote rendering.
- Multi-host routing requires a session broker rather than the single-host
  provider registry.
