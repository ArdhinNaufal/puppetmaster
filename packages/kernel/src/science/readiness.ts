/**
 * Cache an asynchronous readiness probe and collapse all concurrent misses
 * into one in-flight call. Failed probes are shared with current callers but
 * never cached, so the next request can retry immediately.
 */
export function createSingleFlightTtlCache<T>(
  load: () => Promise<T>,
  options: {
    ttlMs: number;
    now?: () => number;
  },
): () => Promise<T> {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error("single-flight cache ttlMs must be a positive safe integer");
  }

  const now = options.now ?? Date.now;
  let cached: { expiresAt: number; value: T } | null = null;
  let inFlight: Promise<T> | null = null;

  return () => {
    const current = now();
    if (cached && cached.expiresAt > current) {
      return Promise.resolve(cached.value);
    }
    if (inFlight) return inFlight;

    const pending = Promise.resolve()
      .then(load)
      .then((value) => {
        cached = { expiresAt: now() + options.ttlMs, value };
        return value;
      });
    const shared = pending.finally(() => {
      if (inFlight === shared) inFlight = null;
    });
    inFlight = shared;
    return shared;
  };
}
