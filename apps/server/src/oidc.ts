import { createRemoteJWKSet, jwtVerify } from "jose";

/**
 * Minimal OpenID Connect (authorization-code flow) as an alternative sign-in to
 * password sessions (ARCHITECTURE.md §6, "later: OIDC"). Enabled only when the
 * OIDC_* env vars are set; discovery, token exchange, and id_token signature
 * verification (via the provider's JWKS) live here as pure functions, while the
 * session is minted by the shared auth layer.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  defaultRole: string;
}

export function oidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER;
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  const redirectUri = process.env.OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !clientSecret || !redirectUri) return null;
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes: process.env.OIDC_SCOPES ?? "openid email profile",
    defaultRole: process.env.OIDC_DEFAULT_ROLE ?? "member",
  };
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: { issuer: string; doc: Discovery } | null = null;

async function discover(issuer: string): Promise<Discovery> {
  if (discoveryCache?.issuer === issuer) return discoveryCache.doc;
  const url = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as Discovery;
  discoveryCache = { issuer, doc };
  return doc;
}

/** Provider authorize URL to redirect the browser to. */
export async function authorizationUrl(cfg: OidcConfig, state: string): Promise<string> {
  const doc = await discover(cfg.issuer);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scopes,
    state,
  });
  return `${doc.authorization_endpoint}?${params.toString()}`;
}

export interface OidcClaims {
  email: string;
  name: string;
  sub: string;
}

/** Exchange the auth code and verify the returned id_token's signature/claims. */
export async function exchangeCode(cfg: OidcConfig, code: string): Promise<OidcClaims> {
  const doc = await discover(cfg.issuer);
  const res = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status}`);
  const token = (await res.json()) as { id_token?: string };
  if (!token.id_token) throw new Error("OIDC token response missing id_token");

  const jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  const { payload } = await jwtVerify(token.id_token, jwks, {
    issuer: cfg.issuer,
    audience: cfg.clientId,
  });
  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) throw new Error("OIDC id_token has no email claim");
  return {
    email,
    name: typeof payload.name === "string" ? payload.name : email,
    sub: String(payload.sub ?? email),
  };
}
