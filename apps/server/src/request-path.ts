const UNSAFE_PATH_CHARACTER = /[\\\0?#]/;

export class InvalidRequestPathError extends Error {
  constructor() {
    super("invalid request path");
    this.name = "InvalidRequestPathError";
  }
}

/**
 * Return the single canonical path used by every security decision.
 *
 * Fastify matches percent-decoded route segments while request.url retains
 * their encoded spelling. Decode exactly once so authorization and rate-limit
 * policy see the same path as routing. A remaining percent marker is ambiguous
 * (and could be decoded again by another hop), so fail closed instead of
 * guessing which representation is authoritative.
 */
export function canonicalRequestPath(rawUrl: string): string {
  const queryStart = rawUrl.indexOf("?");
  const encodedPath = queryStart >= 0 ? rawUrl.slice(0, queryStart) : rawUrl;
  if (encodedPath === "*") return encodedPath;
  if (!encodedPath.startsWith("/")) throw new InvalidRequestPathError();

  let path: string;
  try {
    path = decodeURIComponent(encodedPath);
  } catch {
    throw new InvalidRequestPathError();
  }
  if (path.includes("%") || UNSAFE_PATH_CHARACTER.test(path)) {
    throw new InvalidRequestPathError();
  }
  return path;
}

/** HEAD executes Fastify's GET handler, so it must inherit GET authorization. */
export function authorizationMethod(method: string): string {
  const normalized = method.toUpperCase();
  return normalized === "HEAD" ? "GET" : normalized;
}
