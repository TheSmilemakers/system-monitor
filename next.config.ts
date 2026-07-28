import path from "node:path";
import type { NextConfig } from "next";

/**
 * Security posture for a loopback-only system tool (M-12).
 *
 * Every response carries framing, sniffing and referrer protections. API
 * responses additionally carry `no-store`: they contain a live inventory of the
 * machine (processes, users, permissions, network connections) and must never
 * be written to a shared or disk cache.
 */
const isDev = process.env.NODE_ENV === "development";

/**
 * React's development build uses `eval()` for debugging features (callstack
 * reconstruction, hot reload). Blocking it breaks hydration outright — the page
 * renders its server markup and then never becomes interactive. React never
 * uses `eval()` in production, so the allowance is scoped to development and
 * the shipped policy stays strict.
 */
const SCRIPT_SRC = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next injects an inline bootstrap; keep everything else locked down.
      SCRIPT_SRC,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  // M-13: pin the workspace root so a stray parent lockfile cannot redirect it.
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      {
        source: "/api/:path*",
        headers: [
          ...SECURITY_HEADERS,
          { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
