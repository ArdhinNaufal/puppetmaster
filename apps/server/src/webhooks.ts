import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WorkflowGraph } from "@puppetmaster/shared";

export const WEBHOOK_SIGNATURE_HEADER = "x-puppetmaster-signature";

/** True when a graph contains a webhook-mode trigger node. */
export function graphHasWebhookTrigger(graph: unknown): boolean {
  const parsed = WorkflowGraph.safeParse(graph);
  if (!parsed.success) return false;
  return parsed.data.nodes.some(
    (n) => n.kind === "trigger" && (n.config as { mode?: string } | undefined)?.mode === "webhook",
  );
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/** HMAC-SHA256 of the raw body, hex, as sent in the `sha256=<hex>` header. */
export function signWebhook(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

/** Constant-time verify of the signature header against the raw body. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const expected = signWebhook(secret, rawBody);
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
