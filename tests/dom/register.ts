import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Registers happy-dom as the global DOM for the whole test run (bunfig.toml
 * preloads this file). A per-file import is too late: Testing Library's
 * `screen` binds document.body at import time and ES imports are hoisted.
 * It stays registered: unregistering after a DOM suite raced React's queued
 * work ("window is not defined"), and the route and action suites pass with
 * the DOM present.
 */
GlobalRegistrator.register();

/**
 * The monitor writes its baseline and event log under Application Support.
 * Tests exercise the stats route, which ticks the monitor, so the whole run
 * gets a scratch data directory instead of the user's real one.
 */
process.env.SM_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "sm-test-data-"));
