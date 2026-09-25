#!/usr/bin/env node
/**
 * Launch preflight: fail fast, with a one-line reason, on the environment
 * faults that otherwise surface as HTTP 500 on every page.
 *
 * Runs as `predev` (and can be called directly). It never touches the network
 * and finishes in a few milliseconds.
 *
 * Checks:
 *  1. Node's architecture matches the machine. On Apple Silicon a universal
 *     Node started from a Rosetta context runs as x86_64, and lightningcss
 *     then looks for lightningcss.darwin-x64.node, which bun never installs
 *     on an arm64 host. This is the failure documented in README.md.
 *  2. The lightningcss native binary for this platform and architecture is
 *     actually present.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

function fail(message, hint) {
  console.error(`\x1b[31mpreflight: ${message}\x1b[0m`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

// 1. Architecture. Two subtleties:
//    - `uname -m` cannot tell us what the machine is: a translated process
//      gets "x86_64" back from it too. hw.optional.arm64 is 1 on Apple
//      Silicon no matter how the caller is running.
//    - `bun run` executes `node scripts/...` through its own native node
//      shim, so this process may be arm64 while the `node` that Next's bin
//      resolves from PATH is the universal binary running as x86_64. Ask
//      that node, not ourselves.
if (process.platform === "darwin") {
  let appleSilicon = false;
  try {
    appleSilicon = execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).trim() === "1";
  } catch {
    /* key absent on Intel Macs; not a preflight failure */
  }
  const archOfRealNode = () => {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      const candidate = path.join(dir, "node");
      let real = "";
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (path.basename(real) === "bun") continue; // bun's shim: not what Next runs
      try {
        return execFileSync(real, ["-p", "process.arch"], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    }
    return process.arch;
  };
  const runningArch = archOfRealNode() || process.arch;
  if (process.env.PREFLIGHT_DEBUG === "1") {
    let translated = "?";
    try {
      translated = execFileSync("/usr/sbin/sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" }).trim();
    } catch {
      /* diagnostics only */
    }
    console.error(
      `preflight debug: self=${process.arch} execPath=${process.execPath} appleSilicon=${appleSilicon} ` +
        `realNode=${runningArch} proc_translated(child)=${translated} PATH=${process.env.PATH}`,
    );
  }
  if (appleSilicon && runningArch !== "arm64") {
    fail(
      `Node is running as ${runningArch} on an arm64 Mac (Rosetta).`,
      "Start it natively: prefix the command with `arch -arm64`, or untick " +
        "\"Open using Rosetta\" on the launcher app. If the dev server already ran once under " +
        "Rosetta, also delete .next/dev: Turbopack caches the failed x64 CSS transform. " +
        "See README.md, Troubleshooting.",
    );
  }
}

// 2. lightningcss native binary for this platform/arch.
try {
  const pkgDir = path.dirname(require.resolve("lightningcss/package.json"));
  const name = `lightningcss.${process.platform}-${process.arch}.node`;
  const platformPkg = `lightningcss-${process.platform}-${process.arch}`;
  let platformPkgDir = null;
  try {
    platformPkgDir = path.dirname(require.resolve(`${platformPkg}/package.json`));
  } catch {
    /* optional dependency not installed */
  }
  const present =
    existsSync(path.join(pkgDir, name)) ||
    (platformPkgDir !== null && existsSync(path.join(platformPkgDir, name)));
  if (!present) {
    fail(
      `lightningcss binary ${name} is not installed.`,
      `Run \`bun install\` on this machine; the optional dependency ${platformPkg} should be added.`,
    );
  }
} catch {
  // lightningcss not resolvable at all: `bun install` has not run. Let Next report it.
}
