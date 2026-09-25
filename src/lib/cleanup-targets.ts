import os from "node:os";
import path from "node:path";

/**
 * Server-owned cleanup catalogue.
 *
 * The browser never sends a path or a command — only an opaque `id` from this
 * table. Everything executable lives here, on the server, and is never
 * serialised to the client. This is the structural fix for C-01.
 */

const HOME = os.homedir();

export type CleanupMode = "empty-dir" | "delete-files-older-than";

export interface CleanupTarget {
  /** Opaque, stable identifier — the only value the client may supply. */
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly absPath: string;
  readonly mode: CleanupMode;
  readonly olderThanDays?: number;
  readonly risk: "safe" | "low" | "medium";
  /** Targets needing root are surfaced for visibility but never actioned in-app (L-09). */
  readonly requiresRoot: boolean;
  readonly description: string;
  /** Minimum size before the item is worth showing, in bytes. */
  readonly minSize: number;
}

const MB = 1024 * 1024;

export const CLEANUP_TARGETS: readonly CleanupTarget[] = [
  {
    id: "user-caches",
    category: "Caches",
    name: "App Caches",
    absPath: path.join(HOME, "Library/Caches"),
    mode: "empty-dir",
    // L-10: not "safe" — some apps keep non-rebuildable state here.
    risk: "low",
    requiresRoot: false,
    description: "Application caches. Quit apps first — a few keep state here that is not rebuilt.",
    minSize: MB,
  },
  {
    id: "user-logs",
    category: "Logs",
    name: "User Logs",
    absPath: path.join(HOME, "Library/Logs"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Application log files. Apps create new ones as needed.",
    minSize: MB,
  },
  {
    id: "system-logs",
    category: "Logs",
    name: "System Logs",
    absPath: "/private/var/log",
    mode: "empty-dir",
    risk: "low",
    requiresRoot: true,
    description: "System log files. Requires administrator rights — run manually.",
    minSize: MB,
  },
  {
    id: "trash",
    category: "Trash",
    name: "Trash",
    absPath: path.join(HOME, ".Trash"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Files you already deleted, still occupying disk space.",
    minSize: MB,
  },
  {
    id: "old-downloads",
    category: "Downloads",
    name: "Old Downloads (30+ days)",
    absPath: path.join(HOME, "Downloads"),
    mode: "delete-files-older-than",
    olderThanDays: 30,
    risk: "medium",
    requiresRoot: false,
    description: "Files in Downloads older than 30 days. Review before deleting.",
    minSize: MB,
  },
  {
    id: "xcode-derived-data",
    category: "Developer",
    name: "Xcode DerivedData",
    absPath: path.join(HOME, "Library/Developer/Xcode/DerivedData"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Xcode build artifacts, regenerated on the next build.",
    minSize: 10 * MB,
  },
  {
    id: "xcode-archives",
    category: "Developer",
    name: "Xcode Archives",
    absPath: path.join(HOME, "Library/Developer/Xcode/Archives"),
    mode: "empty-dir",
    // L-10: irreplaceable — needed to re-sign, re-submit and symbolicate shipped builds.
    risk: "medium",
    requiresRoot: false,
    description: "Irreplaceable. Needed to re-sign, re-submit and symbolicate released builds.",
    minSize: 10 * MB,
  },
  {
    id: "ios-simulator-caches",
    category: "Developer",
    name: "iOS Simulator Caches",
    absPath: path.join(HOME, "Library/Developer/CoreSimulator/Caches"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Simulator caches, rebuilt automatically.",
    minSize: 10 * MB,
  },
  {
    id: "bun-cache",
    category: "Developer",
    name: "Bun Cache",
    absPath: path.join(HOME, ".bun/install/cache"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Bun package cache. Packages are re-downloaded when needed.",
    minSize: 10 * MB,
  },
  {
    id: "npm-cache",
    category: "Developer",
    name: "npm Cache",
    absPath: path.join(HOME, ".npm/_cacache"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "npm package cache. Packages are re-downloaded when needed.",
    minSize: 10 * MB,
  },
  {
    id: "yarn-cache",
    category: "Developer",
    name: "Yarn Cache",
    absPath: path.join(HOME, ".cache/yarn"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Yarn package cache. Packages are re-downloaded when needed.",
    minSize: 10 * MB,
  },
  {
    id: "pip-cache",
    category: "Developer",
    name: "pip Cache",
    absPath: path.join(HOME, ".cache/pip"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Python pip cache. Packages are re-downloaded when needed.",
    minSize: 10 * MB,
  },
  {
    id: "homebrew-cache",
    category: "Developer",
    name: "Homebrew Cache",
    absPath: path.join(HOME, "Library/Caches/Homebrew"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Downloaded formula archives.",
    minSize: 10 * MB,
  },
  {
    id: "cocoapods-cache",
    category: "Developer",
    name: "CocoaPods Cache",
    absPath: path.join(HOME, "Library/Caches/CocoaPods"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Pod spec cache, rebuilt on the next install.",
    minSize: 10 * MB,
  },
  {
    id: "user-crash-reports",
    category: "Crash Reports",
    name: "Crash Reports",
    absPath: path.join(HOME, "Library/Logs/DiagnosticReports"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "App crash logs. Safe unless you are actively debugging a crash.",
    minSize: MB,
  },
  {
    id: "system-crash-reports",
    category: "Crash Reports",
    name: "System Crash Reports",
    absPath: "/Library/Logs/DiagnosticReports",
    mode: "empty-dir",
    risk: "low",
    // L-09: previously offered a button that always failed with permission denied.
    requiresRoot: true,
    description: "System crash logs. Requires administrator rights — run manually.",
    minSize: MB,
  },
  {
    id: "ios-backups",
    category: "Backups",
    name: "iOS Device Backups",
    absPath: path.join(HOME, "Library/Application Support/MobileSync/Backup"),
    mode: "empty-dir",
    risk: "medium",
    requiresRoot: false,
    description: "Local iPhone/iPad backups. Safe only if you rely on iCloud backup.",
    minSize: 100 * MB,
  },
  {
    id: "mail-downloads",
    category: "Mail",
    name: "Mail Attachment Downloads",
    absPath: path.join(HOME, "Library/Containers/com.apple.mail/Data/Library/Mail Downloads"),
    mode: "empty-dir",
    risk: "safe",
    requiresRoot: false,
    description: "Cached email attachments, re-downloaded from the server when needed.",
    minSize: 10 * MB,
  },
] as const;

/**
 * Test seam. Tests register a throwaway target that points at a scratch
 * directory beneath a permitted root, so the real deletion path can be
 * exercised without touching the user's caches. Extra targets must still pass
 * the same containment checks as the catalogue; the seam grants no bypass.
 */
let extraTargets: readonly CleanupTarget[] = [];

export function __setExtraCleanupTargets(targets: readonly CleanupTarget[] | null): void {
  extraTargets = targets ?? [];
}

export function getCleanupTarget(id: string): CleanupTarget | null {
  if (typeof id !== "string" || id.length === 0) return null;
  return CLEANUP_TARGETS.find((t) => t.id === id) ?? extraTargets.find((t) => t.id === id) ?? null;
}

/**
 * Deletion may only ever occur at, or beneath, one of these roots.
 * Checked after symlink resolution, so a symlinked target cannot escape.
 */
export const PERMITTED_ROOTS: readonly string[] = [
  path.join(HOME, "Library/Caches"),
  path.join(HOME, "Library/Logs"),
  path.join(HOME, "Library/Developer"),
  path.join(HOME, "Library/Containers/com.apple.mail"),
  path.join(HOME, "Library/Application Support/MobileSync/Backup"),
  path.join(HOME, "Downloads"),
  path.join(HOME, ".Trash"),
  path.join(HOME, ".bun/install/cache"),
  path.join(HOME, ".npm/_cacache"),
  path.join(HOME, ".cache"),
];

/** True when `child` is `parent` itself or lives beneath it. Pure path logic. */
export function isAtOrUnder(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isWithinPermittedRoots(absPath: string): boolean {
  return PERMITTED_ROOTS.some((root) => isAtOrUnder(absPath, root));
}
