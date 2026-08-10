const MAX_PROVIDER_CONTROL_BYTES = 64 * 1024;

/**
 * Provider and storage diagnostics are untrusted control-plane data. Keep
 * enough context for operations while stripping the credential shapes and
 * signed capability URLs most commonly returned by HTTP clients and gateways.
 */
export function redactScienceDiagnostic(
  value: unknown,
  maxLength = 4_000,
): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(
      /([?&](?:sig|signature|token|access[_-]?token|api[_-]?key|key|x-amz-(?:signature|credential|security-token))=)[^&#\s"']*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:"|')?(?:authorization|token|secret|password|passwd|api[_-]?key|access[_-]?key(?:[_-]?id)?|session[_-]?key|credential|private[_-]?key)(?:"|')?\s*[:=]\s*(?:"|')?)(?:bearer\s+)?[^"',;\s}\]]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, "Bearer [REDACTED]")
    .replace(/data:[^,\s"']+,[^\s"']*/gi, "[INLINE_DATA_REDACTED]")
    .replace(/[A-Za-z]:\\(?:[^\\\r\n]+\\)*[^\\\r\n]*/g, "[HOST_PATH]")
    .replace(/\/(?:home|Users|var|tmp)\/[^\s"']+/g, "[HOST_PATH]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, Math.max(1, Math.min(maxLength, 16_000)));
}

function declaredLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function readBoundedResponseText(
  response: Response,
  label: string,
  maxBytes = MAX_PROVIDER_CONTROL_BYTES,
): Promise<string> {
  const declared = declaredLength(response);
  if (declared !== null && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} exceeded the ${maxBytes}-byte control-response limit`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeded the ${maxBytes}-byte control-response limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function readBoundedResponseJson(
  response: Response,
  label: string,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, label);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function rejectRedirectOrOriginChange(
  response: Response,
  expectedOrigin: string,
  label: string,
): Promise<void> {
  let responseOrigin = expectedOrigin;
  try {
    if (response.url) responseOrigin = new URL(response.url).origin;
  } catch {
    responseOrigin = "";
  }
  if (
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    responseOrigin !== expectedOrigin
  ) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label} attempted a redirect or escaped its configured origin`);
  }
}
