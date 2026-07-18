#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const JOURNAL_PREFIX = ".puppetmaster-apply-v2-";
const JOURNAL_NAMESPACE_PREFIX = ".puppetmaster-apply-";
const OWNER = "puppetmaster-workbench-sync-v2";
const V3_JOURNAL_PREFIX = ".puppetmaster-apply-v3-";
const V3_CLEANUP_PREFIX = ".puppetmaster-apply-v3-cleanup-";
const V3_OWNER = "puppetmaster-workbench-sync-v3";
const V3_VERSION = 3;
const V3_TEST_MODE = process.env.PUPPETMASTER_SYNC_TEST_MODE === "1";

function entries(root) {
  return fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
}

function safeToken(value) {
  const token = String(value ?? "").replace(/[^A-Za-z0-9]/g, "");
  if (!token) throw new Error("execution token is empty");
  return token;
}

function requiredIdentity(value, label) {
  const normalized = String(value ?? "");
  if (!normalized || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function requiredGeneration(value) {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("execution generation must be a nonnegative safe integer");
  }
  return generation;
}

function requiredV3Key(value) {
  const requested = String(value ?? "");
  const key = requested.startsWith("env:")
    ? (() => {
        const name = requested.slice(4);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new Error("v3 journal recovery key environment reference is invalid");
        }
        return String(process.env[name] ?? "");
      })()
    : requested.startsWith("file:")
      ? (() => {
          const filename = requested.slice(5);
          if (filename !== "/puppetmaster-state/recovery-key") {
            throw new Error("v3 journal recovery key file reference is invalid");
          }
          const stat = fs.lstatSync(filename);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32 || stat.size > 4096) {
            throw new Error("v3 journal recovery key file is invalid");
          }
          return fs.readFileSync(filename, "utf8");
        })()
    : requested;
  if (key === "-" || key.length < 32 || key.length > 4096 || /[\0\r\n]/.test(key)) {
    throw new Error("v3 journal recovery key is unavailable or invalid");
  }
  return key;
}

/** Hash the complete logical execution identity. Do not sanitize/truncate it:
 * two different durable attempts must never share a journal namespace. */
function v3Token(projectId, executionId, generation) {
  return crypto
    .createHash("sha256")
    .update(`puppetmaster-workbench-sync-v3\0${projectId}\0${executionId}\0${generation}`)
    .digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot sign a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("cannot sign an unsupported value");
}

function hmacHex(key, domain, value) {
  return crypto.createHmac("sha256", key).update(`${domain}\0${value}`).digest("hex");
}

function timingSafeTextEqual(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signEnvelope(kind, payload, key) {
  const encoded = Buffer.from(canonicalJson(payload), "utf8").toString("base64url");
  return `${encoded}.${hmacHex(key, `puppetmaster-workbench-sync-v3:${kind}`, encoded)}`;
}

function verifyEnvelope(kind, receipt, key) {
  const value = String(receipt ?? "");
  const split = value.lastIndexOf(".");
  if (split <= 0) throw new Error(`invalid ${kind} receipt`);
  const encoded = value.slice(0, split);
  const actual = value.slice(split + 1);
  const expected = hmacHex(key, `puppetmaster-workbench-sync-v3:${kind}`, encoded);
  if (!timingSafeTextEqual(actual, expected)) throw new Error(`invalid ${kind} receipt signature`);
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error(`invalid ${kind} receipt payload`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`invalid ${kind} receipt payload`);
  }
  return payload;
}

function fsyncFile(filename) {
  const fd = fs.openSync(filename, "r");
  try {
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      // Deterministic verification also runs on Windows, where some file
      // handles reject fsync. Production copy-back runs in Linux and remains
      // fail-closed for every fsync error there.
      if (process.platform !== "win32" || !["EACCES", "EINVAL", "EPERM"].includes(error?.code)) {
        throw error;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows does not support fsync on directory handles. The production
    // helper runs in Linux containers, where an unexpected failure is fatal.
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EPERM", "EISDIR"].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncTree(root) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    fsyncFile(root);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`cannot fsync unsupported entry ${path.basename(root)}`);
  for (const name of entries(root)) fsyncTree(path.join(root, name));
  fsyncDirectory(root);
}

function writeDurableFile(filename, content, mode = 0o600) {
  const parent = path.dirname(filename);
  const temporary = path.join(parent, `.${path.basename(filename)}.${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(fd, content, { encoding: "utf8" });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filename);
  fsyncDirectory(parent);
}

function failpoint(name) {
  if (V3_TEST_MODE && process.env.PUPPETMASTER_SYNC_FAILPOINT === name) {
    process.stderr.write(`puppetmaster-sync v3 failpoint: ${name}\n`);
    process.exit(86);
  }
}

function relativeName(value) {
  return value.split(path.sep).join("/");
}

function isEnvName(name) {
  return name === ".env" || name.startsWith(".env.");
}

function isAiderControlName(name) {
  // Includes config, dotenv-adjacent model metadata, repo-map caches, command
  // history, and future Aider-owned dotfiles. None are source code the model
  // needs, and several are executable/configuration input to Aider itself.
  return name.startsWith(".aider");
}

function isJournalName(name) {
  return name.startsWith(JOURNAL_NAMESPACE_PREFIX);
}

function journalExcluded(relative) {
  return relativeName(relative)
    .split("/")
    .filter(Boolean)
    .some(isJournalName);
}

/** Files that must never enter a provider-visible snapshot. Match at every
 * depth: nested dotenv files and nested Git/Aider controls are just as capable
 * of carrying credentials or executable configuration as root-level ones. */
function snapshotExcluded(relative) {
  return relativeName(relative)
    .split("/")
    .filter(Boolean)
    .some((name) =>
      name === ".git" ||
      isEnvName(name) ||
      isAiderControlName(name) ||
      isJournalName(name));
}

function replaceableRoot(name) {
  return name !== ".git" &&
    !isEnvName(name) &&
    !isAiderControlName(name) &&
    !isJournalName(name);
}

function remove(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSafeSymlink(
  sourceRoot,
  source,
  relative,
  forbidExcludedTarget,
  allowMissingTarget = false,
) {
  const target = fs.readlinkSync(source);
  if (path.isAbsolute(target) || path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw new Error(`unsafe symbolic link ${relativeName(relative)}: absolute target ${target}`);
  }
  const lexical = path.resolve(path.dirname(source), target);
  if (!pathIsWithin(sourceRoot, lexical)) {
    throw new Error(`unsafe symbolic link ${relativeName(relative)}: target escapes the repository`);
  }
  if (allowMissingTarget) return target;
  let resolved;
  try {
    resolved = fs.realpathSync(source);
  } catch {
    throw new Error(`unsafe symbolic link ${relativeName(relative)}: target is missing or unreadable`);
  }
  if (!pathIsWithin(sourceRoot, resolved)) {
    throw new Error(`unsafe symbolic link ${relativeName(relative)}: resolved target escapes the repository`);
  }
  const resolvedRelative = path.relative(sourceRoot, resolved);
  if (forbidExcludedTarget && snapshotExcluded(resolvedRelative)) {
    throw new Error(`unsafe symbolic link ${relativeName(relative)}: target is provider-excluded control state`);
  }
  return target;
}

function copyNode(sourceRoot, source, target, relative, options = {}) {
  if (options.excludeSnapshotControls && snapshotExcluded(relative)) return;
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    const link = assertSafeSymlink(
      sourceRoot,
      source,
      relative,
      options.forbidExcludedSymlinkTarget === true,
      options.allowMissingSafeSymlink === true,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(link, target);
    return;
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(target, { recursive: false, mode: 0o700 });
    for (const name of entries(source)) {
      copyNode(
        sourceRoot,
        path.join(source, name),
        path.join(target, name),
        path.join(relative, name),
        options,
      );
    }
    fs.chmodSync(target, stat.mode & 0o777);
    fs.utimesSync(target, stat.atime, stat.mtime);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported repository entry ${relativeName(relative)} (only files, directories, and safe symlinks are allowed)`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, stat.mode & 0o777);
  fs.utimesSync(target, stat.atime, stat.mtime);
}

function hashFile(hash, filename) {
  const fd = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function hashNode(hash, root, current, relative) {
  if (snapshotExcluded(relative)) return;
  const stat = fs.lstatSync(current);
  const normalized = relativeName(relative);
  hash.update(`\0${normalized}\0${stat.mode & 0o777}\0`);
  if (stat.isSymbolicLink()) {
    const target = assertSafeSymlink(root, current, relative, true);
    hash.update(`link\0${target}`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update("dir");
    for (const name of entries(current)) {
      hashNode(hash, root, path.join(current, name), path.join(relative, name));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`unsupported repository entry ${normalized}`);
  }
  hash.update(`file\0${stat.size}\0`);
  hashFile(hash, current);
}

/** Digest only provider-managed paths. Protected dotenv/Git/Aider state is
 * intentionally absent so changing it concurrently neither leaks nor gets
 * overwritten by an otherwise valid code copy-back. */
function manifest(root) {
  const hash = crypto.createHash("sha256");
  for (const name of entries(root)) {
    if (!replaceableRoot(name) || snapshotExcluded(name)) continue;
    hashNode(hash, root, path.join(root, name), name);
  }
  return hash.digest("hex");
}

function hashFullNode(hash, root, current, relative) {
  if (journalExcluded(relative)) return;
  const stat = fs.lstatSync(current);
  const normalized = relativeName(relative);
  hash.update(`\0${normalized}\0${stat.mode & 0o777}\0`);
  if (stat.isSymbolicLink()) {
    const target = assertSafeSymlink(root, current, relative, false);
    hash.update(`link\0${target}`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update("dir");
    for (const name of entries(current)) {
      hashFullNode(hash, root, path.join(current, name), path.join(relative, name));
    }
    return;
  }
  if (!stat.isFile()) throw new Error(`unsupported repository entry ${normalized}`);
  hash.update(`file\0${stat.size}\0`);
  hashFile(hash, current);
}

/** Integrity digest of the complete durable tree except Puppetmaster journals.
 * Unlike manifest(), this includes protected Git/dotenv/Aider controls so a
 * committed or restored tree can be proven byte-for-byte. */
function fullManifest(root) {
  const hash = crypto.createHash("sha256");
  for (const name of entries(root)) {
    if (isJournalName(name)) continue;
    hashFullNode(hash, root, path.join(root, name), name);
  }
  return hash.digest("hex");
}

function snapshot(source, target) {
  if (entries(target).length > 0) throw new Error("provider snapshot target is not empty");
  const baseline = manifest(source);
  for (const name of entries(source)) {
    if (!replaceableRoot(name) || snapshotExcluded(name)) continue;
    copyNode(source, path.join(source, name), path.join(target, name), name, {
      excludeSnapshotControls: true,
      forbidExcludedSymlinkTarget: true,
    });
  }
  process.stdout.write(`PUPPETMASTER_BASELINE ${baseline}\n`);
}

function ownerValue(token, key) {
  if (!key || key === "-") throw new Error("journal recovery key is unavailable");
  const signature = crypto.createHmac("sha256", key).update(`${OWNER}\0${token}`).digest("hex");
  return `${OWNER}:${signature}`;
}

function isAuthenticatedJournal(journal, token, key) {
  try {
    const stat = fs.lstatSync(journal);
    const owner = path.join(journal, "owner");
    const ownerStat = fs.lstatSync(owner);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 256) return false;
    const actual = Buffer.from(fs.readFileSync(owner, "utf8"));
    const expected = Buffer.from(ownerValue(token, key));
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function journalPath(root, token) {
  return path.join(root, `${JOURNAL_PREFIX}${safeToken(token)}`);
}

function recoverJournal(root, journal, token, key) {
  if (!isAuthenticatedJournal(journal, token, key)) {
    throw new Error(`refusing unauthenticated copy-back journal ${path.basename(journal)}`);
  }
  const swapping = path.join(journal, "swapping");
  const backup = path.join(journal, "backup");
  if (fs.existsSync(swapping)) {
    const swappingStat = fs.lstatSync(swapping);
    const backupStat = fs.lstatSync(backup);
    if (!swappingStat.isFile() || swappingStat.isSymbolicLink() ||
        !backupStat.isDirectory() || backupStat.isSymbolicLink()) {
      throw new Error(`refusing malformed copy-back journal ${path.basename(journal)}`);
    }
    for (const name of entries(root)) {
      if (replaceableRoot(name)) remove(path.join(root, name));
    }
    // Copy rather than move so recovery is restart-idempotent. If the helper
    // is killed halfway through restoration, the complete backup remains and
    // the next recovery can discard the partial root and retry from scratch.
    for (const name of entries(backup)) {
      copyNode(backup, path.join(backup, name), path.join(root, name), name, {
        allowMissingSafeSymlink: true,
        forbidExcludedSymlinkTarget: false,
      });
    }
  }
  remove(journal);
}

function recover(root, token, key) {
  const journal = journalPath(root, token);
  if (!fs.existsSync(journal)) return false;
  recoverJournal(root, journal, safeToken(token), key);
  return true;
}

function overlayNestedProtected(root, next) {
  const visit = (current, relative) => {
    for (const name of entries(current)) {
      const childRelative = path.join(relative, name);
      const source = path.join(current, name);
      if (snapshotExcluded(childRelative)) {
        const target = path.join(next, childRelative);
        remove(target);
        copyNode(root, source, target, childRelative, { forbidExcludedSymlinkTarget: false });
        continue;
      }
      const stat = fs.lstatSync(source);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(source, childRelative);
    }
  };
  for (const name of entries(root)) {
    if (!replaceableRoot(name)) continue;
    const source = path.join(root, name);
    const stat = fs.lstatSync(source);
    if (stat.isDirectory() && !stat.isSymbolicLink()) visit(source, name);
  }
}

function apply(source, root, tokenValue, expectedBaseline, key) {
  const token = safeToken(tokenValue);
  recover(root, token, key);
  if (expectedBaseline !== "-" && manifest(root) !== expectedBaseline) {
    throw new Error("durable workbench changed after provider snapshot; refusing destructive copy-back");
  }
  const journal = journalPath(root, token);
  const next = path.join(journal, "next");
  const backup = path.join(journal, "backup");
  if (fs.existsSync(journal)) throw new Error("copy-back journal already exists");
  fs.mkdirSync(journal, { recursive: false, mode: 0o700 });
  fs.writeFileSync(path.join(journal, "owner"), ownerValue(token, key), { mode: 0o600, flush: true });
  fs.mkdirSync(next, { recursive: false, mode: 0o700 });
  fs.mkdirSync(backup, { recursive: false, mode: 0o700 });
  try {
    // Build complete next and rollback trees before touching the durable root.
    for (const name of entries(source)) {
      if (!replaceableRoot(name) || snapshotExcluded(name)) continue;
      copyNode(source, path.join(source, name), path.join(next, name), name, {
        excludeSnapshotControls: true,
        forbidExcludedSymlinkTarget: true,
      });
    }
    // Nested protected files were deliberately absent from the provider
    // snapshot. Overlay the durable originals into the next tree.
    overlayNestedProtected(root, next);
    for (const name of entries(root)) {
      if (replaceableRoot(name)) {
        copyNode(root, path.join(root, name), path.join(backup, name), name, {
          forbidExcludedSymlinkTarget: false,
        });
      }
    }
    if (expectedBaseline !== "-" && manifest(root) !== expectedBaseline) {
      throw new Error("durable workbench changed during copy-back preparation; refusing swap");
    }
    fs.writeFileSync(path.join(journal, "swapping"), "1", { mode: 0o600, flush: true });
    for (const name of entries(root)) {
      if (replaceableRoot(name)) remove(path.join(root, name));
    }
    for (const name of entries(next)) {
      fs.renameSync(path.join(next, name), path.join(root, name));
    }
    remove(journal);
  } catch (error) {
    recoverJournal(root, journal, token, key);
    throw error;
  }
}

function v3Identity(projectValue, executionValue, generationValue, keyValue) {
  const projectId = requiredIdentity(projectValue, "project id");
  const executionId = requiredIdentity(executionValue, "execution id");
  const generation = requiredGeneration(generationValue);
  const key = requiredV3Key(keyValue);
  return {
    projectId,
    executionId,
    generation,
    key,
    token: v3Token(projectId, executionId, generation),
  };
}

function v3JournalPath(root, token) {
  return path.join(root, `${V3_JOURNAL_PREFIX}${token}`);
}

function v3CleanupPath(root, token) {
  return path.join(root, `${V3_CLEANUP_PREFIX}${token}`);
}

function assertRegularBounded(filename, maxBytes, label) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error(`refusing malformed v3 copy-back ${label}`);
  }
}

function v3OwnerValue(identity) {
  const binding = canonicalJson({
    executionGeneration: identity.generation,
    executionId: identity.executionId,
    owner: V3_OWNER,
    projectId: identity.projectId,
    token: identity.token,
    version: V3_VERSION,
  });
  return `${V3_OWNER}:${hmacHex(identity.key, "puppetmaster-workbench-sync-v3:owner", binding)}`;
}

function authenticateV3Journal(journal, identity) {
  try {
    const stat = fs.lstatSync(journal);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("journal is not a real directory");
    }
    const owner = path.join(journal, "owner");
    assertRegularBounded(owner, 256, "owner");
    const actual = fs.readFileSync(owner, "utf8");
    if (!timingSafeTextEqual(actual, v3OwnerValue(identity))) {
      throw new Error("owner signature does not match");
    }
  } catch (error) {
    throw new Error(
      `refusing unauthenticated v3 copy-back journal ${path.basename(journal)}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

function writeV3Intent(journal, intent, identity) {
  const encoded = canonicalJson(intent);
  writeDurableFile(path.join(journal, "intent.json"), encoded);
  writeDurableFile(
    path.join(journal, "intent.mac"),
    hmacHex(identity.key, "puppetmaster-workbench-sync-v3:intent", encoded),
  );
  return crypto.createHash("sha256").update(encoded).digest("hex");
}

function readV3Intent(journal, identity, required = true) {
  const intentFile = path.join(journal, "intent.json");
  const macFile = path.join(journal, "intent.mac");
  if (!fs.existsSync(intentFile) && !fs.existsSync(macFile) && !required) return null;
  if (!fs.existsSync(intentFile) || !fs.existsSync(macFile)) {
    throw new Error(`refusing malformed v3 copy-back journal ${path.basename(journal)}: incomplete intent`);
  }
  assertRegularBounded(intentFile, 32 * 1024, "intent");
  assertRegularBounded(macFile, 256, "intent signature");
  const encoded = fs.readFileSync(intentFile, "utf8");
  const actual = fs.readFileSync(macFile, "utf8");
  const expected = hmacHex(identity.key, "puppetmaster-workbench-sync-v3:intent", encoded);
  if (!timingSafeTextEqual(actual, expected)) {
    throw new Error(`refusing unauthenticated v3 copy-back intent ${path.basename(journal)}`);
  }
  let intent;
  try {
    intent = JSON.parse(encoded);
  } catch {
    throw new Error(`refusing malformed v3 copy-back intent ${path.basename(journal)}`);
  }
  if (canonicalJson(intent) !== encoded) {
    throw new Error(`refusing non-canonical v3 copy-back intent ${path.basename(journal)}`);
  }
  const matches =
    intent.version === V3_VERSION &&
    intent.kind === "copyback-intent" &&
    intent.projectId === identity.projectId &&
    intent.executionId === identity.executionId &&
    intent.executionGeneration === identity.generation &&
    intent.token === identity.token &&
    /^[a-f0-9]{64}$/.test(intent.baselineManaged ?? "") &&
    /^[a-f0-9]{64}$/.test(intent.baselineFull ?? "") &&
    /^[a-f0-9]{64}$/.test(intent.candidateManaged ?? "");
  if (!matches) throw new Error(`refusing mismatched v3 copy-back intent ${path.basename(journal)}`);
  return {
    intent,
    digest: crypto.createHash("sha256").update(encoded).digest("hex"),
  };
}

function phaseValue(identity, intentDigest, phase) {
  return hmacHex(
    identity.key,
    "puppetmaster-workbench-sync-v3:phase",
    `${identity.token}\0${intentDigest}\0${phase}`,
  );
}

function writeV3Phase(journal, identity, intentDigest, phase) {
  writeDurableFile(path.join(journal, `${phase}.mac`), phaseValue(identity, intentDigest, phase));
}

function hasValidV3Phase(journal, identity, intentDigest, phase) {
  const filename = path.join(journal, `${phase}.mac`);
  if (!fs.existsSync(filename)) return false;
  assertRegularBounded(filename, 256, `${phase} phase`);
  const actual = fs.readFileSync(filename, "utf8");
  if (!timingSafeTextEqual(actual, phaseValue(identity, intentDigest, phase))) {
    throw new Error(`refusing unauthenticated v3 ${phase} phase ${path.basename(journal)}`);
  }
  return true;
}

function assertV3ReceiptIdentity(payload, kind, identity) {
  if (
    payload.version !== V3_VERSION ||
    payload.kind !== kind ||
    payload.projectId !== identity.projectId ||
    payload.executionId !== identity.executionId ||
    payload.executionGeneration !== identity.generation ||
    payload.token !== identity.token
  ) {
    throw new Error(`${kind} receipt does not match the requested execution`);
  }
}

function verifySnapshotReceipt(receipt, identity) {
  const payload = verifyEnvelope("snapshot", receipt, identity.key);
  assertV3ReceiptIdentity(payload, "snapshot", identity);
  if (!/^[a-f0-9]{64}$/.test(payload.baselineManaged ?? "")) {
    throw new Error("snapshot receipt has an invalid baseline");
  }
  return payload;
}

function verifyCommitReceipt(receipt, identity) {
  const payload = verifyEnvelope("commit", receipt, identity.key);
  assertV3ReceiptIdentity(payload, "commit", identity);
  for (const field of ["baselineManaged", "candidateManaged", "candidateFull", "intentDigest"]) {
    if (!/^[a-f0-9]{64}$/.test(payload[field] ?? "")) {
      throw new Error(`commit receipt has an invalid ${field}`);
    }
  }
  return payload;
}

function readCommittedReceipt(journal, identity, intentRecord) {
  const filename = path.join(journal, "committed.receipt");
  if (!fs.existsSync(filename)) return null;
  assertRegularBounded(filename, 16 * 1024, "committed receipt");
  const receipt = fs.readFileSync(filename, "utf8");
  const payload = verifyCommitReceipt(receipt, identity);
  if (
    payload.intentDigest !== intentRecord.digest ||
    payload.baselineManaged !== intentRecord.intent.baselineManaged ||
    payload.candidateManaged !== intentRecord.intent.candidateManaged
  ) {
    throw new Error(`refusing mismatched v3 committed receipt ${path.basename(journal)}`);
  }
  return { receipt, payload };
}

function writeV3Status(identity, state, detail = {}) {
  const payload = {
    version: V3_VERSION,
    kind: "status",
    projectId: identity.projectId,
    executionId: identity.executionId,
    executionGeneration: identity.generation,
    token: identity.token,
    state,
    ...detail,
  };
  const receipt = signEnvelope("status", payload, identity.key);
  process.stdout.write(`PUPPETMASTER_STATUS_V3 ${receipt}\n`);
  return { payload, receipt };
}

function readV3JournalState(root, journal, identity) {
  authenticateV3Journal(journal, identity);
  const intentRecord = readV3Intent(journal, identity, false);
  if (!intentRecord) {
    for (const phase of ["prepared", "swapping", "db-acked"]) {
      if (fs.existsSync(path.join(journal, `${phase}.mac`))) {
        throw new Error(`refusing malformed v3 copy-back journal ${path.basename(journal)}: phase without intent`);
      }
    }
    if (fs.existsSync(path.join(journal, "committed.receipt"))) {
      throw new Error(`refusing malformed v3 copy-back journal ${path.basename(journal)}: commit without intent`);
    }
    return { state: "initializing", intentRecord: null, committed: null };
  }
  const prepared = hasValidV3Phase(journal, identity, intentRecord.digest, "prepared");
  const swapping = hasValidV3Phase(journal, identity, intentRecord.digest, "swapping");
  const dbAcked = hasValidV3Phase(journal, identity, intentRecord.digest, "db-acked");
  const committed = readCommittedReceipt(journal, identity, intentRecord);
  if ((swapping && !prepared) || (committed && (!prepared || !swapping)) || (dbAcked && !committed)) {
    throw new Error(`refusing malformed v3 copy-back phase ordering ${path.basename(journal)}`);
  }
  if (committed) {
    if (
      manifest(root) !== committed.payload.candidateManaged ||
      fullManifest(root) !== committed.payload.candidateFull
    ) {
      throw new Error(`committed v3 workbench digest mismatch for ${path.basename(journal)}`);
    }
    return {
      state: dbAcked ? "db-acked" : "committed",
      intentRecord,
      committed,
    };
  }
  if (swapping) return { state: "swapping", intentRecord, committed: null };
  if (prepared) return { state: "prepared", intentRecord, committed: null };
  throw new Error(`refusing malformed v3 copy-back journal ${path.basename(journal)}: intent was not prepared`);
}

function pendingJournalNames(root) {
  return entries(root).filter((name) =>
    name.startsWith(JOURNAL_PREFIX) ||
    name.startsWith(V3_JOURNAL_PREFIX) ||
    name.startsWith(V3_CLEANUP_PREFIX));
}

function assertClean(root, allowedName = null) {
  const pending = pendingJournalNames(root).filter((name) => name !== allowedName);
  if (pending.length > 0) {
    throw new Error(
      `durable workbench has pending copy-back state (${pending.join(", ")}); reconcile it before mutation`,
    );
  }
}

function snapshotV3(source, target, identity) {
  if (entries(target).length > 0) throw new Error("provider snapshot target is not empty");
  const before = manifest(source);
  for (const name of entries(source)) {
    if (!replaceableRoot(name) || snapshotExcluded(name)) continue;
    copyNode(source, path.join(source, name), path.join(target, name), name, {
      excludeSnapshotControls: true,
      forbidExcludedSymlinkTarget: true,
    });
  }
  const after = manifest(source);
  const copied = manifest(target);
  if (before !== after || before !== copied) {
    throw new Error("durable workbench changed during provider snapshot; refusing inconsistent snapshot");
  }
  fsyncTree(target);
  const payload = {
    version: V3_VERSION,
    kind: "snapshot",
    projectId: identity.projectId,
    executionId: identity.executionId,
    executionGeneration: identity.generation,
    token: identity.token,
    baselineManaged: before,
  };
  const receipt = signEnvelope("snapshot", payload, identity.key);
  process.stdout.write(`PUPPETMASTER_SNAPSHOT_V3 ${receipt}\n`);
  return receipt;
}

function removeJournalDurably(root, journal) {
  remove(journal);
  fsyncDirectory(root);
}

function recoverV3(root, identity, emit = true) {
  const journal = v3JournalPath(root, identity.token);
  if (!fs.existsSync(journal)) {
    if (emit) writeV3Status(identity, "absent");
    return { state: "absent", receipt: null };
  }
  const current = readV3JournalState(root, journal, identity);
  if (current.state === "committed" || current.state === "db-acked") {
    if (emit) {
      writeV3Status(identity, current.state, {
        commitReceipt: current.committed.receipt,
        candidateManaged: current.committed.payload.candidateManaged,
        candidateFull: current.committed.payload.candidateFull,
      });
    }
    return { state: current.state, receipt: current.committed.receipt };
  }
  if (current.state === "swapping") {
    const backup = path.join(journal, "backup");
    const backupStat = fs.lstatSync(backup);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) {
      throw new Error(`refusing malformed v3 copy-back backup ${path.basename(journal)}`);
    }
    for (const name of entries(root)) {
      if (replaceableRoot(name)) remove(path.join(root, name));
    }
    for (const name of entries(backup)) {
      copyNode(backup, path.join(backup, name), path.join(root, name), name, {
        allowMissingSafeSymlink: true,
        forbidExcludedSymlinkTarget: false,
      });
    }
    fsyncDirectory(root);
    if (
      manifest(root) !== current.intentRecord.intent.baselineManaged ||
      fullManifest(root) !== current.intentRecord.intent.baselineFull
    ) {
      throw new Error(`v3 copy-back rollback digest mismatch for ${path.basename(journal)}`);
    }
    removeJournalDurably(root, journal);
    if (emit) writeV3Status(identity, "rolled-back");
    return { state: "rolled-back", receipt: null };
  }
  // No authenticated swapping marker means the durable root was never touched.
  removeJournalDurably(root, journal);
  if (emit) writeV3Status(identity, "discarded");
  return { state: "discarded", receipt: null };
}

function statusV3(root, identity) {
  const journal = v3JournalPath(root, identity.token);
  const cleanup = v3CleanupPath(root, identity.token);
  if (!fs.existsSync(journal)) {
    if (fs.existsSync(cleanup)) {
      authenticateV3Journal(cleanup, identity);
      return writeV3Status(identity, "cleanup-pending");
    }
    return writeV3Status(identity, "absent");
  }
  const current = readV3JournalState(root, journal, identity);
  return writeV3Status(identity, current.state, current.committed
    ? {
        commitReceipt: current.committed.receipt,
        candidateManaged: current.committed.payload.candidateManaged,
        candidateFull: current.committed.payload.candidateFull,
      }
    : {});
}

function applyV3(source, root, identity, snapshotReceipt) {
  const snapshotPayload = verifySnapshotReceipt(snapshotReceipt, identity);
  const journal = v3JournalPath(root, identity.token);
  const journalName = path.basename(journal);
  assertClean(root, fs.existsSync(journal) ? journalName : null);
  if (fs.existsSync(journal)) {
    const current = readV3JournalState(root, journal, identity);
    if (current.state === "committed" || current.state === "db-acked") {
      process.stdout.write(`PUPPETMASTER_COMMIT_V3 ${current.committed.receipt}\n`);
      return current.committed.receipt;
    }
    recoverV3(root, identity, false);
  }
  if (manifest(root) !== snapshotPayload.baselineManaged) {
    throw new Error("durable workbench changed after v3 provider snapshot; refusing destructive copy-back");
  }
  fs.mkdirSync(journal, { recursive: false, mode: 0o700 });
  fsyncDirectory(root);
  writeDurableFile(path.join(journal, "owner"), v3OwnerValue(identity));
  const next = path.join(journal, "next");
  const backup = path.join(journal, "backup");
  fs.mkdirSync(next, { recursive: false, mode: 0o700 });
  fs.mkdirSync(backup, { recursive: false, mode: 0o700 });
  fsyncDirectory(journal);
  try {
    const sourceBefore = manifest(source);
    for (const name of entries(source)) {
      if (!replaceableRoot(name) || snapshotExcluded(name)) continue;
      copyNode(source, path.join(source, name), path.join(next, name), name, {
        excludeSnapshotControls: true,
        forbidExcludedSymlinkTarget: true,
      });
    }
    overlayNestedProtected(root, next);
    const baselineFull = fullManifest(root);
    for (const name of entries(root)) {
      if (replaceableRoot(name)) {
        copyNode(root, path.join(root, name), path.join(backup, name), name, {
          forbidExcludedSymlinkTarget: false,
        });
      }
    }
    const sourceAfter = manifest(source);
    const candidateManaged = manifest(next);
    if (sourceBefore !== sourceAfter || sourceBefore !== candidateManaged) {
      throw new Error("provider result changed during v3 copy-back preparation");
    }
    fsyncTree(next);
    fsyncTree(backup);
    const intent = {
      version: V3_VERSION,
      kind: "copyback-intent",
      projectId: identity.projectId,
      executionId: identity.executionId,
      executionGeneration: identity.generation,
      token: identity.token,
      baselineManaged: snapshotPayload.baselineManaged,
      baselineFull,
      candidateManaged,
    };
    const intentDigest = writeV3Intent(journal, intent, identity);
    writeV3Phase(journal, identity, intentDigest, "prepared");
    failpoint("after-prepared");
    if (
      manifest(root) !== snapshotPayload.baselineManaged ||
      fullManifest(root) !== baselineFull
    ) {
      throw new Error("durable workbench changed during v3 copy-back preparation; refusing swap");
    }
    writeV3Phase(journal, identity, intentDigest, "swapping");
    failpoint("after-swapping");
    let changedRoot = false;
    for (const name of entries(root)) {
      if (!replaceableRoot(name)) continue;
      remove(path.join(root, name));
      if (!changedRoot) {
        changedRoot = true;
        failpoint("mid-swap");
      }
    }
    for (const name of entries(next)) {
      fs.renameSync(path.join(next, name), path.join(root, name));
      if (!changedRoot) {
        changedRoot = true;
        failpoint("mid-swap");
      }
    }
    fsyncDirectory(root);
    failpoint("before-committed");
    if (manifest(root) !== candidateManaged) {
      throw new Error("v3 copy-back candidate digest mismatch after swap");
    }
    const candidateFull = fullManifest(root);
    const commitPayload = {
      version: V3_VERSION,
      kind: "commit",
      projectId: identity.projectId,
      executionId: identity.executionId,
      executionGeneration: identity.generation,
      token: identity.token,
      baselineManaged: snapshotPayload.baselineManaged,
      candidateManaged,
      candidateFull,
      intentDigest,
    };
    const receipt = signEnvelope("commit", commitPayload, identity.key);
    writeDurableFile(path.join(journal, "committed.receipt"), receipt);
    failpoint("after-committed");
    process.stdout.write(`PUPPETMASTER_COMMIT_V3 ${receipt}\n`);
    return receipt;
  } catch (error) {
    try {
      recoverV3(root, identity, false);
    } catch (recoveryError) {
      throw new Error(
        `v3 copy-back failed and rollback could not be proven: ${
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
        }`,
        { cause: error },
      );
    }
    throw error;
  }
}

function ackV3(root, identity, commitReceipt) {
  verifyCommitReceipt(commitReceipt, identity);
  const journal = v3JournalPath(root, identity.token);
  const cleanup = v3CleanupPath(root, identity.token);
  if (!fs.existsSync(journal)) {
    if (fs.existsSync(cleanup)) {
      // A valid DB-held receipt authorizes cleanup of only this identity-derived
      // tombstone; journal content is never interpreted when authentication is
      // incomplete after a crash during deletion.
      remove(cleanup);
      fsyncDirectory(root);
    }
    writeV3Status(identity, "acked");
    return;
  }
  const current = readV3JournalState(root, journal, identity);
  if (!current.committed || !timingSafeTextEqual(current.committed.receipt, commitReceipt)) {
    throw new Error("refusing v3 acknowledgment with a mismatched commit receipt");
  }
  if (current.state !== "db-acked") {
    writeV3Phase(journal, identity, current.intentRecord.digest, "db-acked");
  }
  failpoint("after-db-acked");
  // Remove bulky rollback trees only after DB acknowledgment. The signed
  // owner/intent/commit/ack records remain until the atomic tombstone rename.
  remove(path.join(journal, "next"));
  remove(path.join(journal, "backup"));
  fsyncDirectory(journal);
  if (fs.existsSync(cleanup)) {
    throw new Error(`refusing pre-existing v3 cleanup tombstone ${path.basename(cleanup)}`);
  }
  fs.renameSync(journal, cleanup);
  fsyncDirectory(root);
  failpoint("after-ack-rename");
  remove(cleanup);
  fsyncDirectory(root);
  writeV3Status(identity, "acked");
}

const [command, ...args] = process.argv.slice(2);
if (command === "self-test") process.exit(0);
if (command === "snapshot" && args[0] && args[1]) {
  snapshot(path.resolve(args[0]), path.resolve(args[1]));
  process.exit(0);
}
if (command === "recover" && args[0] && args[1] && args[2]) {
  recover(path.resolve(args[0]), args[1], args[2]);
  process.exit(0);
}
if (command === "apply" && args[0] && args[1] && args[2] && args[3] && args[4]) {
  apply(path.resolve(args[0]), path.resolve(args[1]), args[2], args[3], args[4]);
  process.exit(0);
}
if (command === "assert-clean" && args[0]) {
  assertClean(path.resolve(args[0]));
  process.exit(0);
}
if (command === "snapshot-v3" && args.length === 6) {
  const identity = v3Identity(args[2], args[3], args[4], args[5]);
  snapshotV3(path.resolve(args[0]), path.resolve(args[1]), identity);
  process.exit(0);
}
if (command === "apply-v3" && args.length === 7) {
  const identity = v3Identity(args[2], args[3], args[4], args[6]);
  applyV3(path.resolve(args[0]), path.resolve(args[1]), identity, args[5]);
  process.exit(0);
}
if (command === "status-v3" && args.length === 5) {
  const identity = v3Identity(args[1], args[2], args[3], args[4]);
  statusV3(path.resolve(args[0]), identity);
  process.exit(0);
}
if (command === "recover-v3" && args.length === 5) {
  const identity = v3Identity(args[1], args[2], args[3], args[4]);
  recoverV3(path.resolve(args[0]), identity);
  process.exit(0);
}
if (command === "ack-v3" && args.length === 6) {
  const identity = v3Identity(args[1], args[2], args[3], args[5]);
  ackV3(path.resolve(args[0]), identity, args[4]);
  process.exit(0);
}
console.error(
  "usage: puppetmaster-sync self-test | snapshot <source> <target> | " +
  "recover <root> <token> <key> | apply <source> <root> <token> <baseline|-> <key> | " +
  "assert-clean <root> | snapshot-v3 <source> <target> <project> <execution> <generation> <key> | " +
  "apply-v3 <source> <root> <project> <execution> <generation> <snapshot-receipt> <key> | " +
  "status-v3|recover-v3 <root> <project> <execution> <generation> <key> | " +
  "ack-v3 <root> <project> <execution> <generation> <commit-receipt> <key>",
);
process.exit(64);
