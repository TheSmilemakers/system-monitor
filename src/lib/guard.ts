import { headers } from "next/headers";

/**
 * Application-boundary enforcement for a loopback-only tool (H-01).
 *
 * Deliberately enforced inside each route handler and server action rather than
 * in middleware: the Next.js releases this app targets have carried repeated
 * Middleware/Proxy *bypass* advisories, and a bypass must not translate into an
 * authorisation bypass. Handler-level checks cannot be routed around.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Strip the port and normalise, so any loopback port is acceptable. */
function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim();
  // Bracketed IPv6 literal, optionally with a port.
  const v6 = trimmed.match(/^(\[[^\]]+\])(?::\d+)?$/)?.[1];
  if (v6) return v6;
  return trimmed.replace(/:\d+$/, "");
}

export function isLoopbackHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  return LOOPBACK_HOSTNAMES.has(hostnameOf(hostHeader));
}

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  // Absent Origin is normal for same-origin GETs and direct navigation.
  if (!origin) return true;
  try {
    return (
      LOOPBACK_HOSTNAMES.has(`${new URL(origin).hostname}`) ||
      LOOPBACK_HOSTNAMES.has(`[${new URL(origin).hostname}]`)
    );
  } catch {
    return false;
  }
}

type HeadersProvider = () => Promise<{ get(name: string): string | null }>;

/**
 * Test seam. `next/headers` only works inside a request scope; tests install a
 * provider that returns the headers under test so route handlers and server
 * actions can be invoked directly.
 */
let headersProvider: HeadersProvider | null = null;

export function __setHeadersProvider(fn: HeadersProvider | null): void {
  headersProvider = fn;
}

/**
 * Throws {@link ForbiddenError} unless the request originates from loopback.
 * Call at the top of every route handler and every server action.
 */
export async function assertLocalRequest(): Promise<void> {
  const h = headersProvider ? await headersProvider() : await headers();

  const host = h.get("host");
  if (!isLoopbackHost(host)) {
    throw new ForbiddenError(`Refused: non-loopback Host "${host ?? "<absent>"}"`);
  }

  const origin = h.get("origin");
  if (!isAllowedOrigin(origin)) {
    throw new ForbiddenError(`Refused: cross-origin request from "${origin}"`);
  }
}
