#!/usr/bin/env node
/**
 * Accessibility gate: axe-core against the running app in headless Chrome.
 *
 * Boots the production server (no dev lock), opens each page in Chrome over
 * the DevTools protocol, waits for the data to land, injects axe and fails
 * on any serious or critical violation. Moderate and minor findings are
 * printed for the record. The bench is checked twice, with the inspector
 * open the second time, since the drawer is where the actions live.
 *
 * No Playwright: Node's WebSocket and Chrome's own protocol are enough, so
 * CI needs only the Chrome that the macOS runner already ships.
 *
 *   bun run build && node scripts/a11y.mjs
 *   CHROME_BIN=/path/to/chrome node scripts/a11y.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 90_000;
const SETTLE_TIMEOUT_MS = 30_000;
const FAIL_IMPACTS = new Set(["serious", "critical"]);

// The theme is pinned by query so the result does not depend on the OS
// appearance of whichever machine runs this (CI runners are light).
const PAGES = [
  { name: "bench, night shift", path: "/?theme=dark", ready: "[role=grid]", inspect: true },
  { name: "bench, daylight", path: "/?theme=light", ready: "[role=grid]", inspect: true },
  { name: "mini window, night shift", path: "/mini?theme=dark", ready: "main" },
  { name: "mini window, daylight", path: "/mini?theme=light", ready: "main" },
  { name: "shift report, night shift", path: "/report?theme=dark", ready: "pre" },
  { name: "shift report, daylight", path: "/report?theme=light", ready: "pre" },
];

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  const mark = pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${name}`);
  if (detail) for (const line of detail.split("\n")) console.log(`\x1b[2m        ${line}\x1b[0m`);
};

function chromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

// ---------- the app server ----------

async function bootServer() {
  const child = spawn("bun", ["run", "start", "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const tail = log
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trim()
        .split("\n")
        .slice(-8)
        .join("\n  ");
      throw new Error(
        `server exited early (code ${child.exitCode}); run bun run build first?\n  ${tail}`,
      );
    }
    try {
      const res = await fetch(`${BASE}/api/stats`, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return child;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("server did not become ready");
}

// ---------- Chrome over the DevTools protocol ----------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else {
        for (const l of this.listeners) l(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  waitFor(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        timeoutMs,
      );
      const l = (msg) => {
        if (msg.method !== method) return;
        clearTimeout(timer);
        this.listeners = this.listeners.filter((x) => x !== l);
        resolve(msg.params);
      };
      this.listeners.push(l);
    });
  }
  /** Evaluate an expression in the page and return its value; promises are awaited. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

async function launchChrome(binary, profileDir) {
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "--window-size=1440,990",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let err = "";
  child.stderr.on("data", (d) => (err += d.toString()));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(err);
    if (m) return { child, port: Number(m[1]) };
    if (child.exitCode !== null) throw new Error(`Chrome exited early: ${err.slice(-300)}`);
    await sleep(100);
  }
  throw new Error("Chrome did not expose DevTools");
}

async function openPage(devtoolsPort, url) {
  const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json/new?${url}`, { method: "PUT" });
  if (!res.ok) throw new Error(`could not open a tab: HTTP ${res.status}`);
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("DevTools socket failed")), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return { cdp, close: () => ws.close(), id: target.id };
}

async function settle(cdp, selector) {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ready = await cdp.eval(
      `Boolean(document.querySelector(${JSON.stringify(selector)})) && !/Loading system stats/.test(document.body.innerText)`,
    );
    if (ready) break;
    await sleep(250);
  }
  // One more beat for the last paint: lamps, segments, sparkline mounts.
  await sleep(600);
}

async function runAxe(cdp) {
  await cdp.eval(`${AXE_SOURCE}; true`);
  const raw = await cdp.eval(
    `axe.run(document, { resultTypes: ["violations"] }).then((r) => JSON.stringify(r.violations))`,
  );
  return JSON.parse(raw);
}

function describe(violations) {
  return violations
    .map((v) => {
      const nodes = v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(", ");
      const more = v.nodes.length > 3 ? ` (+${v.nodes.length - 3} more)` : "";
      return `${v.impact}: ${v.id}: ${v.help}\n  ${nodes}${more}`;
    })
    .join("\n");
}

async function checkPage(devtoolsPort, page) {
  const { cdp, close } = await openPage(devtoolsPort, `${BASE}${page.path}`);
  try {
    await settle(cdp, page.ready);
    report(page.name, await runAxe(cdp));

    if (page.inspect) {
      // Open the inspector on the first process and check the drawer too.
      const opened = await cdp.eval(
        `(() => { const b = document.querySelector('[aria-label^="Inspect "]'); if (!b) return false; b.click(); return true; })()`,
      );
      if (opened) {
        await settle(cdp, "aside");
        report(`${page.name}, inspector open`, await runAxe(cdp));
      } else {
        record(`${page.name}, inspector open`, false, "no process row to inspect");
      }
    }
  } finally {
    close();
  }
}

function report(name, violations) {
  const failing = violations.filter((v) => FAIL_IMPACTS.has(v.impact));
  const advisory = violations.filter((v) => !FAIL_IMPACTS.has(v.impact));
  const detail = [
    failing.length ? describe(failing) : "",
    advisory.length ? `advisory only:\n${describe(advisory)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  record(`${name}: no serious or critical violations`, failing.length === 0, detail || "clean");
}

async function main() {
  console.log("\n\x1b[1mAccessibility (axe-core in headless Chrome)\x1b[0m");
  console.log("─".repeat(74));

  const binary = chromeBinary();
  if (!binary) {
    console.error("  Chrome not found. Set CHROME_BIN to a Chrome or Chromium binary.");
    process.exit(1);
  }

  const profileDir = mkdtempSync(path.join(os.tmpdir(), "sm-a11y-"));
  let server = null;
  let chrome = null;
  const cleanup = () => {
    for (const c of [server, chrome]) {
      try {
        c?.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    rmSync(profileDir, { recursive: true, force: true });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    server = await bootServer();
    const launched = await launchChrome(binary, profileDir);
    chrome = launched.child;
    for (const page of PAGES) {
      try {
        await checkPage(launched.port, page);
      } catch (e) {
        record(page.name, false, e instanceof Error ? e.message : String(e));
      }
    }
  } finally {
    cleanup();
  }

  console.log("─".repeat(74));
  const passed = results.filter((r) => r.pass).length;
  const ok = passed === results.length;
  console.log(
    ok
      ? `  \x1b[32m\x1b[1mA11Y PASSED — ${passed}/${results.length}\x1b[0m\n`
      : `  \x1b[31m\x1b[1mA11Y FAILED — ${passed}/${results.length}\x1b[0m\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n\x1b[31mAccessibility check error: ${e.message}\x1b[0m\n`);
  process.exit(1);
});
