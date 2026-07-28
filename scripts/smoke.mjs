#!/usr/bin/env node
/**
 * Boot-and-render smoke test.
 *
 * Exists because `next build`, `tsc --noEmit` and `eslint` all passed green
 * while the dev server returned HTTP 500 on every page load: `globals.css`
 * imported a stylesheet from the `shadcn` package after that package was
 * removed from dependencies, and Turbopack panicked at request time.
 *
 * A build that compiles is not an app that runs. This starts the server for
 * real and asserts the page and every API endpoint actually respond.
 *
 *   node scripts/smoke.mjs [--prod]
 */

import { spawn } from "node:child_process";
import http from "node:http";
import process from "node:process";

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const PROD = process.argv.includes("--prod");
const BOOT_TIMEOUT_MS = 90_000;

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  const mark = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${name}`);
  if (detail) console.log(`\x1b[2m        ${detail}\x1b[0m`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a path with an explicit Host header. Returns the status code. */
function requestWithHost(path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", headers: { Host: host }, timeout: 60_000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    req.end();
  });
}

async function waitForBoot(child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode})`);
    try {
      const res = await fetch(`${BASE}/api/stats`, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

async function main() {
  const cmd = PROD ? ["run", "start"] : ["run", "dev"];
  const child = spawn("bun", [...cmd, "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let serverLog = "";
  child.stdout.on("data", (d) => { serverLog += d.toString(); });
  child.stderr.on("data", (d) => { serverLog += d.toString(); });

  const cleanup = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });

  try {
    console.log(`\n\x1b[1mSmoke test (${PROD ? "production" : "development"})\x1b[0m`);
    console.log("─".repeat(74));

    const booted = await waitForBoot(child);
    record("server boots", booted, booted ? `listening on ${BASE}` : "did not become ready");
    if (!booted) throw new Error("boot failed");

    // The regression that motivated this script.
    const page = await fetch(BASE);
    const html = await page.text();
    record(
      "page renders (HTTP 200, not a build-time panic)",
      page.status === 200,
      `HTTP ${page.status}`,
    );
    record(
      "page contains the dashboard shell",
      /System Monitor/.test(html),
      /System Monitor/.test(html) ? "heading present" : "heading missing",
    );

    // A Turbopack/webpack panic surfaces in the log even when a status looks sane.
    const panicked = /FATAL|panic|Failed to write app endpoint/i.test(serverLog);
    record("no bundler panic in server output", !panicked,
      panicked ? serverLog.split("\n").find((l) => /FATAL|panic/i.test(l))?.slice(0, 120) : "clean");

    for (const route of ["/api/stats", "/api/scan", "/api/cleanup", "/api/privacy"]) {
      const res = await fetch(`${BASE}${route}`, { signal: AbortSignal.timeout(60_000) });
      record(`${route} responds`, res.status === 200, `HTTP ${res.status}`);
    }

    // The security boundary, exercised against the running server.
    // `fetch` silently drops Host (a forbidden header), so it cannot test this —
    // use node:http, which does send whatever Host it is given.
    const forged = await requestWithHost("/api/stats", "evil.example.com");
    record("forged Host is refused", forged === 403, `HTTP ${forged}`);

    const lanHost = await requestWithHost("/api/stats", "192.168.1.48:3199");
    record("LAN Host is refused", lanHost === 403, `HTTP ${lanHost}`);

    const loopback = await requestWithHost("/api/stats", `localhost:${PORT}`);
    record("loopback Host is served", loopback === 200, `HTTP ${loopback}`);

    const headers = (await fetch(`${BASE}/api/stats`)).headers;
    const cc = headers.get("cache-control") ?? "";
    record("system JSON is not cacheable", cc.includes("no-store"), cc || "absent");
    const csp = headers.get("content-security-policy") ?? "";
    record("CSP forbids framing", csp.includes("frame-ancestors 'none'"), csp ? "present" : "absent");
  } finally {
    cleanup();
    await sleep(300);
  }

  console.log("─".repeat(74));
  const passed = results.filter((r) => r.pass).length;
  const ok = passed === results.length;
  console.log(
    ok
      ? `  \x1b[32m\x1b[1mSMOKE PASSED — ${passed}/${results.length}\x1b[0m\n`
      : `  \x1b[31m\x1b[1mSMOKE FAILED — ${passed}/${results.length}\x1b[0m\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n\x1b[31mSmoke test error: ${e.message}\x1b[0m\n`);
  process.exit(1);
});
