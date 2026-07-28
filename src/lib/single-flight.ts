/**
 * Collapse concurrent identical work onto one in-flight promise (H-02).
 *
 * Without this, N browser tabs — or a poll interval shorter than the response
 * time — each start their own expensive system scan, and because the work was
 * previously synchronous they serialised, so latency grew without bound.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const p = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, p);
  return p;
}

/** Number of operations currently in flight — test seam. */
export function inFlightCount(): number {
  return inFlight.size;
}
