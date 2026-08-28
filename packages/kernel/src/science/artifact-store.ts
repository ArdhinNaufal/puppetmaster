import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  link,
  open,
  readdir,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { redactScienceDiagnostic } from "./http-boundary.js";

export interface ArtifactByteRange {
  start: number;
  end: number;
}

export interface ArtifactRead {
  body: NodeJS.ReadableStream;
  size: number;
  range: ArtifactByteRange | null;
}

export interface ArtifactWriteReceipt {
  quarantineKey: string;
  sha256: string;
  size: number;
}

export interface ArtifactReference {
  /** Provider-safe HTTP URL. It must never contain a filesystem path. */
  url: string;
  expiresAt: string;
  sha256: string;
  size: number;
  method: "GET";
}

export interface ArtifactStoreHealth {
  ok: boolean;
  adapter: string;
  detail?: string;
}

function artifactAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("artifact operation aborted");
}

function awaitArtifactOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(artifactAbortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(artifactAbortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export interface ArtifactStore {
  readonly adapter: string;
  createQuarantine(key: string): Promise<string>;
  writeQuarantine(
    quarantineKey: string,
    body: AsyncIterable<Uint8Array>,
    /** On abort, implementations must stop writer activity and settle before returning. */
    opts: { maxBytes: number; signal?: AbortSignal },
  ): Promise<ArtifactWriteReceipt>;
  openQuarantine(
    quarantineKey: string,
    range?: ArtifactByteRange | null,
  ): Promise<ArtifactRead>;
  discardQuarantine(quarantineKey: string): Promise<void>;
  promote(
    quarantineKey: string,
    storageKey: string,
    expected: { sha256: string; size: number },
  ): Promise<void>;
  open(storageKey: string, range?: ArtifactByteRange | null): Promise<ArtifactRead>;
  remove(storageKey: string, opts?: { signal?: AbortSignal }): Promise<void>;
  cleanupQuarantine(
    olderThan: Date,
    protectedKeys?: ReadonlySet<string>,
  ): Promise<number>;
  reference(
    storageKey: string,
    input: {
      versionId: string;
      sha256: string;
      size: number;
      audience: string;
      ttlSeconds: number;
    },
  ): Promise<ArtifactReference>;
  verifyReference(input: {
    versionId: string;
    audience: string;
    expires: string;
    signature: string;
    sha256: string;
    size: number;
  }): boolean;
  health(): Promise<ArtifactStoreHealth>;
}

function assertKey(key: string): void {
  if (
    !key ||
    isAbsolute(key) ||
    key.includes("\0") ||
    key.split(/[\\/]/).some((part) => part === ".." || part === ".")
  ) {
    throw new Error("invalid artifact storage key");
  }
}

function pathWithin(root: string, key: string): string {
  assertKey(key);
  const target = resolve(root, key);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("artifact path escaped the configured root");
  }
  return target;
}

async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const raw of createReadStream(path)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), size };
}

function safeEqualReceipt(
  actual: { sha256: string; size: number },
  expected: { sha256: string; size: number },
): boolean {
  return actual.size === expected.size && actual.sha256 === expected.sha256.toLowerCase();
}

function createInternalReference(
  secret: Buffer,
  publicBaseUrl: string,
  storageKey: string,
  input: {
    versionId: string;
    sha256: string;
    size: number;
    audience: string;
    ttlSeconds: number;
  },
): ArtifactReference {
  assertKey(storageKey);
  const id = input.versionId;
  const expires = Math.floor(Date.now() / 1000) + Math.max(1, Math.min(input.ttlSeconds, 3600));
  const payload = `${id}\n${input.audience}\n${expires}\n${input.sha256}\n${input.size}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  const query = new URLSearchParams({
    audience: input.audience,
    expires: String(expires),
    sig,
  });
  return {
    url: `${publicBaseUrl}/${encodeURIComponent(id)}/content?${query}`,
    expiresAt: new Date(expires * 1000).toISOString(),
    sha256: input.sha256,
    size: input.size,
    method: "GET",
  };
}

export function verifyArtifactReference(
  secret: string | Buffer,
  input: {
    versionId: string;
    audience: string;
    expires: string;
    signature: string;
    sha256: string;
    size: number;
  },
): boolean {
  const expires = Number(input.expires);
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  if (!/^[0-9a-f]{64}$/i.test(input.signature)) return false;
  const payload =
    `${input.versionId}\n${input.audience}\n${expires}\n${input.sha256}\n${input.size}`;
  const actual = createHmac("sha256", secret).update(payload).digest();
  const supplied = Buffer.from(input.signature, "hex");
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

/**
 * Development/test artifact store.
 *
 * Upload bytes land under `.quarantine` and become addressable only after an
 * atomic rename into `objects`. Callers persist opaque relative keys; absolute
 * host paths are never returned across this boundary.
 */
export class FilesystemArtifactStore implements ArtifactStore {
  readonly adapter = "filesystem";
  private readonly root: string;
  private readonly referenceSecret: Buffer;
  private readonly publicBaseUrl: string;

  constructor(opts: {
    root: string;
    referenceSecret: string | Buffer;
    publicBaseUrl?: string;
  }) {
    if (!opts.root) throw new Error("filesystem artifact root is required");
    this.root = resolve(opts.root);
    this.referenceSecret = Buffer.isBuffer(opts.referenceSecret)
      ? opts.referenceSecret
      : Buffer.from(opts.referenceSecret, "utf8");
    if (this.referenceSecret.length < 16) {
      throw new Error("artifact reference secret must be at least 16 bytes");
    }
    this.publicBaseUrl = (opts.publicBaseUrl ?? "/api/science/artifact-versions").replace(/\/$/, "");
  }

  async createQuarantine(key: string): Promise<string> {
    assertKey(key);
    const quarantineKey = `.quarantine/${key}.part`;
    const path = pathWithin(this.root, quarantineKey);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    return quarantineKey;
  }

  async writeQuarantine(
    quarantineKey: string,
    body: AsyncIterable<Uint8Array>,
    opts: { maxBytes: number; signal?: AbortSignal },
  ): Promise<ArtifactWriteReceipt> {
    if (!quarantineKey.startsWith(".quarantine/")) {
      throw new Error("write target is not a quarantine key");
    }
    if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0) {
      throw new Error("maxBytes must be a nonnegative safe integer");
    }
    opts.signal?.throwIfAborted();
    const path = pathWithin(this.root, quarantineKey);
    const before = await awaitArtifactOperation(stat(path), opts.signal);
    opts.signal?.throwIfAborted();
    if (before.size !== 0) {
      throw new Error("upload already contains bytes; start a new upload intent");
    }

    const output = createWriteStream(path, { flags: "r+", mode: 0o600 });
    let outputAborted = false;
    const abortOutput = () => {
      if (outputAborted) return;
      outputAborted = true;
      const reason = opts.signal?.reason;
      output.destroy(
        reason instanceof Error ? reason : new Error("artifact quarantine write aborted"),
      );
    };
    opts.signal?.addEventListener("abort", abortOutput, { once: true });
    if (opts.signal?.aborted) abortOutput();
    const hash = createHash("sha256");
    let size = 0;
    let complete = false;
    try {
      for await (const raw of body) {
        opts.signal?.throwIfAborted();
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        size += chunk.length;
        if (size > opts.maxBytes) {
          throw new Error(`upload exceeds the ${opts.maxBytes}-byte limit`);
        }
        hash.update(chunk);
        if (!output.write(chunk)) {
          await once(output, "drain", { signal: opts.signal });
        }
      }
      opts.signal?.throwIfAborted();
      output.end();
      await finished(output);
      complete = true;
      return { quarantineKey, sha256: hash.digest("hex"), size };
    } finally {
      opts.signal?.removeEventListener("abort", abortOutput);
      if (!complete) {
        // `createWriteStream` opens asynchronously. On an early size/stream
        // rejection, wait for its terminal event before the caller removes
        // the quarantine path; otherwise a late open can emit an unhandled
        // ENOENT after the failed ingestion has already returned.
        const settled = finished(output).catch(() => {});
        output.destroy();
        await settled;
      }
    }
  }

  async discardQuarantine(quarantineKey: string): Promise<void> {
    if (!quarantineKey.startsWith(".quarantine/")) {
      throw new Error("discard target is not a quarantine key");
    }
    await unlink(pathWithin(this.root, quarantineKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async promote(
    quarantineKey: string,
    storageKey: string,
    expected: { sha256: string; size: number },
  ): Promise<void> {
    if (!quarantineKey.startsWith(".quarantine/")) {
      throw new Error("promotion source is not a quarantine key");
    }
    if (!storageKey.startsWith("objects/")) {
      throw new Error("promotion target is not an object key");
    }
    const source = pathWithin(this.root, quarantineKey);
    const target = pathWithin(this.root, storageKey);
    let receipt;
    try {
      receipt = await sha256File(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Crash recovery: promotion may have completed before the database
      // version was marked ready. The immutable destination is sufficient
      // proof even when the quarantine link was already removed.
      const existing = await sha256File(target).catch(() => null);
      if (existing && safeEqualReceipt(existing, expected)) return;
      throw new Error("promotion source is missing and no matching immutable object exists");
    }
    if (!safeEqualReceipt(receipt, expected)) {
      throw new Error("quarantine bytes do not match the declared checksum and size");
    }
    await mkdir(dirname(target), { recursive: true });
    try {
      // A hard link is an atomic create-if-absent on the same filesystem.
      // Unlike rename on POSIX it cannot overwrite an immutable object.
      await link(source, target);
      await unlink(source);
    } catch (error) {
      const fsError = error as NodeJS.ErrnoException;
      if (fsError.code !== "EEXIST") throw error;
      const existing = await sha256File(target);
      if (!safeEqualReceipt(existing, expected)) throw error;
      await this.discardQuarantine(quarantineKey);
    }
  }

  private async openKey(key: string, range?: ArtifactByteRange | null): Promise<ArtifactRead> {
    const path = pathWithin(this.root, key);
    const info = await stat(path);
    if (!info.isFile()) throw new Error("artifact object is not a file");
    if (!range) {
      return { body: createReadStream(path), size: info.size, range: null };
    }
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= info.size
    ) {
      throw new RangeError("invalid artifact byte range");
    }
    return {
      body: createReadStream(path, { start: range.start, end: range.end }),
      size: info.size,
      range,
    };
  }

  async openQuarantine(
    quarantineKey: string,
    range?: ArtifactByteRange | null,
  ): Promise<ArtifactRead> {
    if (!quarantineKey.startsWith(".quarantine/")) {
      throw new Error("read target is not a quarantine key");
    }
    return this.openKey(quarantineKey, range);
  }

  async open(storageKey: string, range?: ArtifactByteRange | null): Promise<ArtifactRead> {
    if (!storageKey.startsWith("objects/")) {
      throw new Error("read target is not an object key");
    }
    return this.openKey(storageKey, range);
  }

  async remove(storageKey: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    opts.signal?.throwIfAborted();
    await unlink(pathWithin(this.root, storageKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    opts.signal?.throwIfAborted();
  }

  async cleanupQuarantine(
    olderThan: Date,
    protectedKeys: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    let removed = 0;
    const walk = async (key: string): Promise<void> => {
      const dir = pathWithin(this.root, key);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const childKey = `${key}/${entry.name}`;
        const child = pathWithin(this.root, childKey);
        if (entry.isDirectory()) {
          await walk(childKey);
          await rmdir(child).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error;
          });
        } else if (entry.isFile()) {
          if (protectedKeys.has(childKey)) continue;
          const info = await stat(child);
          if (info.mtime < olderThan) {
            await rm(child, { force: true });
            removed++;
          }
        }
      }
    };
    await walk(".quarantine");
    return removed;
  }

  async reference(
    storageKey: string,
    input: {
      versionId: string;
      sha256: string;
      size: number;
      audience: string;
      ttlSeconds: number;
    },
  ): Promise<ArtifactReference> {
    return createInternalReference(
      this.referenceSecret,
      this.publicBaseUrl,
      storageKey,
      input,
    );
  }

  verifyReference(input: {
    versionId: string;
    audience: string;
    expires: string;
    signature: string;
    sha256: string;
    size: number;
  }): boolean {
    return verifyArtifactReference(this.referenceSecret, input);
  }

  async health(): Promise<ArtifactStoreHealth> {
    try {
      await mkdir(this.root, { recursive: true });
      const info = await stat(this.root);
      return { ok: info.isDirectory(), adapter: this.adapter };
    } catch (error) {
      return {
        ok: false,
        adapter: this.adapter,
        detail: redactScienceDiagnostic(error, 1_000),
      };
    }
  }
}

interface S3RequestSignature {
  url: URL;
  headers: Record<string, string>;
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function amzTimestamp(date: Date): { timestamp: string; datestamp: string } {
  const timestamp = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { timestamp, datestamp: timestamp.slice(0, 8) };
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

/**
 * S3-compatible final object adapter with a local, streaming quarantine.
 *
 * Keeping incomplete bytes local avoids buffering an upload in memory and
 * avoids exposing multipart objects before checksum validation. Promotion
 * streams the verified file to S3 with a SigV4-signed PUT.
 */
export class S3CompatibleArtifactStore implements ArtifactStore {
  readonly adapter = "s3-compatible";
  private readonly quarantine: FilesystemArtifactStore;
  private readonly quarantineRoot: string;
  private readonly endpoint: URL;
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly referenceSecret: Buffer;
  private readonly publicBaseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(opts: {
    endpoint: string;
    region?: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    quarantineRoot: string;
    referenceSecret: string | Buffer;
    publicBaseUrl?: string;
    requestTimeoutMs?: number;
  }) {
    this.endpoint = new URL(opts.endpoint);
    if (this.endpoint.protocol !== "http:" && this.endpoint.protocol !== "https:") {
      throw new Error("S3 endpoint must use HTTP or HTTPS");
    }
    if (
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    ) {
      throw new Error("S3 endpoint cannot contain credentials, query, or fragment");
    }
    this.endpoint.pathname = this.endpoint.pathname.replace(/\/+$/, "");
    this.region = opts.region?.trim() || "us-east-1";
    this.bucket = opts.bucket.trim();
    this.accessKeyId = opts.accessKeyId.trim();
    this.secretAccessKey = opts.secretAccessKey;
    if (!this.bucket || !this.accessKeyId || !this.secretAccessKey) {
      throw new Error("S3 bucket and credentials are required");
    }
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5 * 60_000;
    if (
      !Number.isSafeInteger(this.requestTimeoutMs) ||
      this.requestTimeoutMs <= 0 ||
      this.requestTimeoutMs > 60 * 60_000
    ) {
      throw new Error("S3 request timeout must be an integer between 1 and 3600000 milliseconds");
    }
    this.quarantineRoot = resolve(opts.quarantineRoot);
    this.referenceSecret = Buffer.isBuffer(opts.referenceSecret)
      ? opts.referenceSecret
      : Buffer.from(opts.referenceSecret, "utf8");
    if (this.referenceSecret.length < 16) {
      throw new Error("artifact reference secret must be at least 16 bytes");
    }
    this.publicBaseUrl = (opts.publicBaseUrl ?? "/api/science/artifact-versions").replace(/\/$/, "");
    this.quarantine = new FilesystemArtifactStore({
      root: this.quarantineRoot,
      referenceSecret: this.referenceSecret,
      publicBaseUrl: this.publicBaseUrl,
    });
  }

  private async request(
    signed: S3RequestSignature,
    init: RequestInit = {},
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetch(signed.url, {
      ...init,
      signal,
      headers: signed.headers,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error("S3 request redirected");
    }
    if (
      response.url &&
      new URL(response.url).origin !== this.endpoint.origin
    ) {
      await response.body?.cancel().catch(() => {});
      throw new Error("S3 response escaped the configured endpoint origin");
    }
    return response;
  }

  private sign(
    method: "GET" | "PUT" | "DELETE" | "HEAD",
    key: string,
    input?: {
      payloadSha256?: string;
      range?: string;
      contentLength?: number;
      ifNoneMatch?: boolean;
      metadataSha256?: string;
    },
  ): S3RequestSignature {
    assertKey(key);
    const path = [
      ...this.endpoint.pathname.split("/").filter(Boolean),
      this.bucket,
      ...key.split(/[\\/]/),
    ].map(awsEncode).join("/");
    const url = new URL(this.endpoint);
    url.pathname = `/${path}`;
    url.search = "";
    const now = amzTimestamp(new Date());
    const payloadHash = input?.payloadSha256 ??
      createHash("sha256").update("").digest("hex");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": now.timestamp,
    };
    if (input?.range) headers.range = input.range;
    if (input?.contentLength !== undefined) headers["content-length"] = String(input.contentLength);
    if (input?.ifNoneMatch) headers["if-none-match"] = "*";
    if (input?.metadataSha256) headers["x-amz-meta-sha256"] = input.metadataSha256;
    const signedNames = Object.keys(headers).sort();
    const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
    const canonicalRequest = [
      method,
      url.pathname,
      "",
      canonicalHeaders,
      signedNames.join(";"),
      payloadHash,
    ].join("\n");
    const scope = `${now.datestamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      now.timestamp,
      scope,
      createHash("sha256").update(canonicalRequest).digest("hex"),
    ].join("\n");
    const dateKey = hmac(`AWS4${this.secretAccessKey}`, now.datestamp);
    const regionKey = hmac(dateKey, this.region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope},` +
      `SignedHeaders=${signedNames.join(";")},Signature=${signature}`;
    delete headers.host;
    return { url, headers };
  }

  createQuarantine(key: string): Promise<string> {
    return this.quarantine.createQuarantine(key);
  }

  writeQuarantine(
    quarantineKey: string,
    body: AsyncIterable<Uint8Array>,
    opts: { maxBytes: number; signal?: AbortSignal },
  ): Promise<ArtifactWriteReceipt> {
    return this.quarantine.writeQuarantine(quarantineKey, body, opts);
  }

  discardQuarantine(quarantineKey: string): Promise<void> {
    return this.quarantine.discardQuarantine(quarantineKey);
  }

  openQuarantine(
    quarantineKey: string,
    range?: ArtifactByteRange | null,
  ): Promise<ArtifactRead> {
    return this.quarantine.openQuarantine(quarantineKey, range);
  }

  async promote(
    quarantineKey: string,
    storageKey: string,
    expected: { sha256: string; size: number },
  ): Promise<void> {
    if (!quarantineKey.startsWith(".quarantine/")) {
      throw new Error("promotion source is not a quarantine key");
    }
    if (!storageKey.startsWith("objects/")) {
      throw new Error("promotion target is not an object key");
    }
    const path = pathWithin(this.quarantineRoot, quarantineKey);
    let receipt;
    try {
      receipt = await sha256File(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // S3 PUT may have committed before the process persisted the ready
      // transition. Verify the immutable object and make retry a no-op.
      const head = this.sign("HEAD", storageKey);
      const existing = await this.request(head, { method: "HEAD" });
      const same =
        existing.ok &&
        Number(existing.headers.get("content-length")) === expected.size &&
        existing.headers.get("x-amz-meta-sha256") === expected.sha256;
      if (same) return;
      throw new Error("promotion source is missing and no matching immutable S3 object exists");
    }
    if (!safeEqualReceipt(receipt, expected)) {
      throw new Error("quarantine bytes do not match the declared checksum and size");
    }
    const signed = this.sign("PUT", storageKey, {
      payloadSha256: expected.sha256,
      contentLength: expected.size,
      ifNoneMatch: true,
      metadataSha256: expected.sha256,
    });
    const body = createReadStream(path);
    const response = await this.request(signed, {
      method: "PUT",
      body: Readable.toWeb(body) as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (response.status === 412) {
      body.destroy();
      const head = this.sign("HEAD", storageKey);
      const existing = await this.request(head, { method: "HEAD" });
      const same =
        existing.ok &&
        Number(existing.headers.get("content-length")) === expected.size &&
        existing.headers.get("x-amz-meta-sha256") === expected.sha256;
      if (!same) throw new Error("S3 object key already exists with different immutable bytes");
      await this.discardQuarantine(quarantineKey);
      return;
    }
    if (!response.ok) {
      body.destroy();
      throw new Error(`S3 promotion failed with ${response.status}`);
    }
    await this.discardQuarantine(quarantineKey);
  }

  async open(storageKey: string, range?: ArtifactByteRange | null): Promise<ArtifactRead> {
    const rangeHeader = range ? `bytes=${range.start}-${range.end}` : undefined;
    const signed = this.sign("GET", storageKey, { range: rangeHeader });
    const response = await this.request(signed);
    if (!response.ok || !response.body) {
      throw new Error(`S3 read failed with ${response.status}`);
    }
    let fullSize: number;
    if (range) {
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get("content-range") ?? "",
      );
      const contentLength = Number(response.headers.get("content-length"));
      if (
        response.status !== 206 ||
        !contentRange ||
        Number(contentRange[1]) !== range.start ||
        Number(contentRange[2]) !== range.end ||
        Number(contentRange[3]) <= range.end ||
        contentLength !== range.end - range.start + 1
      ) {
        await response.body.cancel();
        throw new Error("S3 range response did not match the requested byte range");
      }
      fullSize = Number(contentRange[3]);
    } else {
      if (response.status !== 200) {
        await response.body.cancel();
        throw new Error(`S3 full read returned unexpected status ${response.status}`);
      }
      fullSize = Number(response.headers.get("content-length"));
    }
    if (!Number.isSafeInteger(fullSize) || fullSize < 0) {
      await response.body.cancel();
      throw new Error("S3 response did not include a valid object size");
    }
    return {
      body: Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      size: fullSize,
      range: range ?? null,
    };
  }

  async remove(storageKey: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    const signed = this.sign("DELETE", storageKey);
    const response = await this.request(signed, { method: "DELETE", signal: opts.signal });
    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 delete failed with ${response.status}`);
    }
    if (
      response.headers.get("x-amz-delete-marker")?.toLowerCase() === "true" ||
      response.headers.has("x-amz-version-id")
    ) {
      throw new Error(
        "versioned S3 deletion cannot prove physical byte removal; quota remains retained",
      );
    }
    const head = this.sign("HEAD", storageKey);
    const absence = await this.request(head, { method: "HEAD", signal: opts.signal });
    if (absence.status !== 404) {
      await absence.body?.cancel().catch(() => {});
      throw new Error(
        absence.ok
          ? "S3 object remained addressable after delete"
          : `S3 delete absence proof failed with ${absence.status}`,
      );
    }
  }

  cleanupQuarantine(
    olderThan: Date,
    protectedKeys?: ReadonlySet<string>,
  ): Promise<number> {
    return this.quarantine.cleanupQuarantine(olderThan, protectedKeys);
  }

  async reference(
    storageKey: string,
    input: {
      versionId: string;
      sha256: string;
      size: number;
      audience: string;
      ttlSeconds: number;
    },
  ): Promise<ArtifactReference> {
    return createInternalReference(
      this.referenceSecret,
      this.publicBaseUrl,
      storageKey,
      input,
    );
  }

  verifyReference(input: {
    versionId: string;
    audience: string;
    expires: string;
    signature: string;
    sha256: string;
    size: number;
  }): boolean {
    return verifyArtifactReference(this.referenceSecret, input);
  }

  async health(): Promise<ArtifactStoreHealth> {
    try {
      const local = await this.quarantine.health();
      if (!local.ok) return { ...local, adapter: this.adapter };
      // A signed GET for a deliberately absent key proves DNS, TLS, auth, and
      // bucket routing. 404 is healthy; 401/403 and network failures are not.
      const signed = this.sign("GET", ".health/probe");
      const response = await this.request(signed, {
        signal: AbortSignal.timeout(5_000),
      });
      return {
        ok: response.status === 404 || response.ok,
        adapter: this.adapter,
        ...(!response.ok && response.status !== 404 ? { detail: `S3 returned ${response.status}` } : {}),
      };
    } catch (error) {
      return {
        ok: false,
        adapter: this.adapter,
        detail: redactScienceDiagnostic(error, 1_000),
      };
    }
  }
}
