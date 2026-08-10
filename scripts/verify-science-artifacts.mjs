#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  FilesystemArtifactStore,
  S3CompatibleArtifactStore,
  verifyArtifactReference,
} from "../packages/kernel/dist/science/artifact-store.js";

const secret = "science-artifact-verifier-secret";
const root = await mkdtemp(join(tmpdir(), "puppetmaster-science-artifacts-"));

async function bytesOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function verifyAdapter(store, label) {
  const versionId = randomUUID();
  const objectKey = `objects/${randomUUID()}/${randomUUID()}/${versionId}`;
  const content = Buffer.from("0123456789-science-artifact", "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const quarantine = await store.createQuarantine(randomUUID());
  const receipt = await store.writeQuarantine(quarantine, Readable.from([content]), {
    maxBytes: content.length,
  });
  assert.deepEqual(
    { sha256: receipt.sha256, size: receipt.size },
    { sha256, size: content.length },
    `${label}: streaming receipt`,
  );
  await store.promote(quarantine, objectKey, receipt);

  const full = await store.open(objectKey);
  assert.deepEqual(await bytesOf(full.body), content, `${label}: full read`);
  assert.equal(full.size, content.length);

  const ranged = await store.open(objectKey, { start: 3, end: 8 });
  assert.deepEqual(await bytesOf(ranged.body), content.subarray(3, 9), `${label}: range read`);
  assert.equal(ranged.size, content.length);

  const emptyObjectKey = `objects/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
  const emptyQuarantine = await store.createQuarantine(randomUUID());
  const emptyReceipt = await store.writeQuarantine(
    emptyQuarantine,
    Readable.from([Buffer.alloc(0)]),
    { maxBytes: 0 },
  );
  assert.deepEqual(
    { sha256: emptyReceipt.sha256, size: emptyReceipt.size },
    {
      sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      size: 0,
    },
    `${label}: zero-byte receipt`,
  );
  await store.promote(emptyQuarantine, emptyObjectKey, emptyReceipt);
  assert.deepEqual(
    await bytesOf((await store.open(emptyObjectKey)).body),
    Buffer.alloc(0),
    `${label}: zero-byte object`,
  );
  const zeroBound = await store.createQuarantine(randomUUID());
  await assert.rejects(
    store.writeQuarantine(zeroBound, Readable.from([Buffer.from([0x01])]), { maxBytes: 0 }),
    /exceeds the 0-byte limit/i,
    `${label}: the first excess byte is rejected at a zero-byte bound`,
  );
  await store.discardQuarantine(zeroBound);
  await store.remove(emptyObjectKey);

  const duplicate = await store.createQuarantine(randomUUID());
  await store.writeQuarantine(duplicate, Readable.from([content]), { maxBytes: content.length });
  await store.promote(duplicate, objectKey, { sha256, size: content.length });

  const changed = Buffer.from("different immutable bytes", "utf8");
  const changedHash = createHash("sha256").update(changed).digest("hex");
  const conflict = await store.createQuarantine(randomUUID());
  await store.writeQuarantine(conflict, Readable.from([changed]), { maxBytes: changed.length });
  await assert.rejects(
    store.promote(conflict, objectKey, { sha256: changedHash, size: changed.length }),
    /different|exist|immutable/i,
    `${label}: an existing key cannot be overwritten`,
  );
  await store.discardQuarantine(conflict);

  const reference = await store.reference(objectKey, {
    versionId,
    sha256,
    size: content.length,
    audience: "provider:run-fixture",
    ttlSeconds: 60,
  });
  assert.ok(reference.url.startsWith("/api/science/artifact-versions/"));
  const parsed = new URL(reference.url, "http://localhost");
  assert.equal(
    verifyArtifactReference(secret, {
      versionId,
      audience: parsed.searchParams.get("audience"),
      expires: parsed.searchParams.get("expires"),
      signature: parsed.searchParams.get("sig"),
      sha256,
      size: content.length,
    }),
    true,
    `${label}: scoped reference signature`,
  );
  assert.equal(
    verifyArtifactReference(secret, {
      versionId,
      audience: "provider:other-run",
      expires: parsed.searchParams.get("expires"),
      signature: parsed.searchParams.get("sig"),
      sha256,
      size: content.length,
    }),
    false,
    `${label}: reference audience is bound`,
  );

  await store.remove(objectKey);
  await assert.rejects(store.open(objectKey), /ENOENT|404|failed/i);
}

try {
  const filesystem = new FilesystemArtifactStore({
    root: join(root, "filesystem"),
    referenceSecret: secret,
  });
  await verifyAdapter(filesystem, "filesystem");

  const interrupted = await filesystem.createQuarantine(randomUUID());
  async function* failingUpload() {
    yield Buffer.from("partial");
    throw new Error("fixture transport interrupted");
  }
  await assert.rejects(
    filesystem.writeQuarantine(interrupted, failingUpload(), { maxBytes: 100 }),
    /fixture transport interrupted/,
  );
  await assert.rejects(
    filesystem.open(`objects/${randomUUID()}`),
    /ENOENT/,
    "interrupted uploads never become addressable objects",
  );
  await filesystem.discardQuarantine(interrupted);

  const objects = new Map();
  let redirectHealth = false;
  let malformedRange = false;
  let stallDelete = false;
  let versionedDelete = false;
  const server = createServer(async (request, response) => {
    assert.match(request.headers.authorization ?? "", /^AWS4-HMAC-SHA256 /);
    const key = request.url.split("?")[0];
    if (key.endsWith("/.health/probe")) {
      if (redirectHealth) {
        response.writeHead(302, { location: "/redirect-target" }).end();
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (stallDelete && request.method === "DELETE") {
      return;
    }
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] === "*" && objects.has(key)) {
        response.writeHead(412).end();
        return;
      }
      const body = await bytesOf(request);
      objects.set(key, {
        body,
        sha256: request.headers["x-amz-meta-sha256"],
      });
      response.writeHead(200).end();
      return;
    }
    const object = objects.get(key);
    if (!object) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(200, {
        "content-length": object.body.length,
        "x-amz-meta-sha256": object.sha256,
      }).end();
      return;
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      response.writeHead(204, versionedDelete ? {
        "x-amz-delete-marker": "true",
        "x-amz-version-id": "fixture-version-id",
      } : {}).end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (match) {
      if (malformedRange) {
        response.writeHead(200, {
          "content-length": object.body.length,
        }).end(object.body);
        return;
      }
      const start = Number(match[1]);
      const end = Number(match[2]);
      const body = object.body.subarray(start, end + 1);
      response.writeHead(206, {
        "content-length": body.length,
        "content-range": `bytes ${start}-${end}/${object.body.length}`,
      }).end(body);
      return;
    }
    response.writeHead(200, { "content-length": object.body.length }).end(object.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const s3 = new S3CompatibleArtifactStore({
      endpoint: `http://127.0.0.1:${address.port}`,
      bucket: "science",
      accessKeyId: "fixture-access",
      secretAccessKey: "fixture-secret",
      quarantineRoot: join(root, "s3-quarantine"),
      referenceSecret: secret,
    });
    await verifyAdapter(s3, "s3-compatible");
    assert.equal((await s3.health()).ok, true);
    const rangeKey = `objects/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    const rangeBytes = Buffer.from("bounded-range-fixture");
    const rangeQuarantine = await s3.createQuarantine(randomUUID());
    const rangeReceipt = await s3.writeQuarantine(
      rangeQuarantine,
      Readable.from([rangeBytes]),
      { maxBytes: rangeBytes.length },
    );
    await s3.promote(rangeQuarantine, rangeKey, rangeReceipt);
    malformedRange = true;
    await assert.rejects(
      s3.open(rangeKey, { start: 1, end: 3 }),
      /range response/i,
    );
    malformedRange = false;
    await s3.remove(rangeKey);
    redirectHealth = true;
    const redirectedHealth = await s3.health();
    assert.equal(redirectedHealth.ok, false);
    assert.match(redirectedHealth.detail ?? "", /redirect/i);
    redirectHealth = false;
    const timeoutBoundS3 = new S3CompatibleArtifactStore({
      endpoint: `http://127.0.0.1:${address.port}`,
      bucket: "science",
      accessKeyId: "fixture-access",
      secretAccessKey: "fixture-secret",
      quarantineRoot: join(root, "s3-timeout-quarantine"),
      referenceSecret: secret,
      requestTimeoutMs: 50,
    });
    stallDelete = true;
    await assert.rejects(
      timeoutBoundS3.remove(`objects/${randomUUID()}/${randomUUID()}/${randomUUID()}`),
      /abort|timeout/i,
      "S3 operations abort at the configured total request bound",
    );
    stallDelete = false;
    const versionedKey = `objects/${randomUUID()}/${randomUUID()}/${randomUUID()}`;
    const versionedBytes = Buffer.from("versioned-delete-fixture");
    const versionedQuarantine = await s3.createQuarantine(randomUUID());
    const versionedReceipt = await s3.writeQuarantine(
      versionedQuarantine,
      Readable.from([versionedBytes]),
      { maxBytes: versionedBytes.length },
    );
    await s3.promote(versionedQuarantine, versionedKey, versionedReceipt);
    versionedDelete = true;
    await assert.rejects(
      s3.remove(versionedKey),
      /versioned S3 deletion cannot prove physical byte removal/i,
      "a delete marker must never release physical-storage accounting",
    );
    versionedDelete = false;
    for (const endpoint of [
      `http://fixture:secret@127.0.0.1:${address.port}`,
      `http://127.0.0.1:${address.port}?token=secret`,
      `http://127.0.0.1:${address.port}#secret`,
    ]) {
      assert.throws(
        () => new S3CompatibleArtifactStore({
          endpoint,
          bucket: "science",
          accessKeyId: "fixture-access",
          secretAccessKey: "fixture-secret",
          quarantineRoot: join(root, "s3-invalid"),
          referenceSecret: secret,
        }),
        /credentials, query, or fragment/i,
      );
    }
    assert.throws(
      () => new S3CompatibleArtifactStore({
        endpoint: `http://127.0.0.1:${address.port}`,
        bucket: "science",
        accessKeyId: "fixture-access",
        secretAccessKey: "fixture-secret",
        quarantineRoot: join(root, "s3-invalid-timeout"),
        referenceSecret: secret,
        requestTimeoutMs: 0,
      }),
      /request timeout must be an integer/i,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("SCIENCE ARTIFACT PASS: streaming quarantine, checksum, immutability, range, bounded S3, scoped refs");
