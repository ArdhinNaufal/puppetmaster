import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Credentials vault crypto (Stage 1, G3). Secrets are sealed with AES-256-GCM
 * under a key derived from PUPPETMASTER_MASTER_KEY (scrypt, fixed app salt) so
 * any passphrase-strength master key works. Envelope format, hex-encoded:
 *
 *   v1:<12-byte iv>:<16-byte auth tag>:<ciphertext>
 *
 * The auth tag makes tampering with stored ciphertext detectable at decrypt.
 */

const VERSION = "v1";
const KDF_SALT = "puppetmaster-vault-v1";

function deriveKey(masterKey: string): Buffer {
  return scryptSync(masterKey, KDF_SALT, 32);
}

export function encryptSecret(masterKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("hex"), tag.toString("hex"), ct.toString("hex")].join(":");
}

export function decryptSecret(masterKey: string, envelope: string): string {
  const [version, ivHex, tagHex, ctHex] = envelope.split(":");
  if (version !== VERSION || !ivHex || !tagHex || !ctHex) {
    throw new Error("vault: malformed secret envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterKey), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

const CREDENTIAL_REF = /\{\{\s*credential:([\w.-]+)\s*\}\}/g;

/** Names referenced as `{{credential:NAME}}` anywhere in an env map. */
export function credentialRefs(env: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const value of Object.values(env)) {
    for (const m of value.matchAll(CREDENTIAL_REF)) names.add(m[1]!);
  }
  return [...names];
}

/**
 * Replace `{{credential:NAME}}` references in an env map with decrypted
 * values. Throws when a referenced credential is missing so a misconfigured
 * MCP server fails loudly at connect instead of running with a placeholder.
 */
export async function resolveCredentialEnv(
  env: Record<string, string>,
  lookup: (name: string) => Promise<string | null>,
): Promise<Record<string, string>> {
  const names = credentialRefs(env);
  const values = new Map<string, string>();
  for (const name of names) {
    const value = await lookup(name);
    if (value == null) throw new Error(`credential "${name}" is not in the vault`);
    values.set(name, value);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = v.replace(CREDENTIAL_REF, (_, name: string) => values.get(name) ?? "");
  }
  return out;
}
