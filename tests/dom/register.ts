import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers happy-dom as the global DOM for the whole test run (bunfig.toml
 * preloads this file). A per-file import is too late: Testing Library's
 * `screen` binds document.body at import time and ES imports are hoisted.
 * It stays registered: unregistering after a DOM suite raced React's queued
 * work ("window is not defined"), and the route and action suites pass with
 * the DOM present.
 */
GlobalRegistrator.register();
