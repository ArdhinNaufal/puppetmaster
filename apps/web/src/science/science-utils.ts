import { useEffect, useState } from "react";
import { ApiError, type ScienceRunState } from "../api.js";

export const SCIENCE_PAGE_SIZE = 24;
export const SCIENCE_STATIC_RENDER_MAX_BYTES = 8 * 1024 * 1024;
/** Web Crypto digests whole buffers. Keep the browser path bounded; larger
 * artifacts must use the same upload-intent/stream/complete REST contract from
 * an operator-controlled streaming client instead of risking tab OOM. This
 * does not imply that a separate S3 user workflow is available. */
export const SCIENCE_CLIENT_HASH_MAX_BYTES = 256 * 1024 * 1024;
export const SCIENCE_ACTIVE_RUN_STATES = new Set<ScienceRunState>([
  "awaiting_approval",
  "queued",
  "provisioning",
  "running",
  "finalizing",
  "cancelling",
]);

export function scienceError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      const detail = error.message.trim();
      return !detail || detail.toLowerCase() === "not found"
        ? "Science service is not installed on this server."
        : detail;
    }
    if (error.status === 403) return "Your role cannot perform this Science operation.";
    if (error.status === 409) return error.message || "Science state changed; refresh and try again.";
    return error.message || `Science request failed (${error.status}).`;
  }
  return error instanceof Error ? error.message : "Science request failed.";
}

export function fmtBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "N/A";
  if (value === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtElapsed(start: string | null | undefined, end?: string | null): string {
  if (!start) return "N/A";
  const ms = Date.parse(end ?? "") || Date.now();
  const delta = Math.max(0, ms - Date.parse(start));
  if (!Number.isFinite(delta)) return "N/A";
  if (delta < 1_000) return `${delta} ms`;
  if (delta < 60_000) return `${(delta / 1_000).toFixed(1)} s`;
  const mins = Math.floor(delta / 60_000);
  const secs = Math.floor((delta % 60_000) / 1_000);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

export function fmtClock(value: string | null | undefined): string {
  if (!value) return "N/A";
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "N/A";
}

export function shortHash(value: string | null | undefined, length = 12): string {
  return value ? value.slice(0, length) : "N/A";
}

export async function sha256Blob(blob: Blob): Promise<string> {
  if (blob.size > SCIENCE_CLIENT_HASH_MAX_BYTES) {
    throw new Error(
      `Browser checksum limit is ${fmtBytes(SCIENCE_CLIENT_HASH_MAX_BYTES)}; contact an operator to use the documented streaming REST upload contract for this artifact.`,
    );
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("This browser does not provide Web Crypto SHA-256.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Runtime-reactive, unlike the shell's historical one-time preference sample. */
export function usePrefersReducedMotion(): boolean {
  const read = () =>
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  const [reduced, setReduced] = useState(read);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const change = () => setReduced(media.matches);
    media.addEventListener?.("change", change);
    return () => media.removeEventListener?.("change", change);
  }, []);

  return reduced;
}

export function randomIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `science-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
