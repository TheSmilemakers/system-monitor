import type { ProcessInfo, TrustState } from "./schemas";

/**
 * Pure, client-side reasoning over the process list: sorting, filtering,
 * parent chains, app grouping, trust lamps and plain-language hints. No DOM,
 * no network, so every rule is unit-tested without a browser.
 */

export type SortKey =
  | "cpu"
  | "mem"
  | "rss"
  | "pid"
  | "ppid"
  | "command"
  | "publisher"
  | "path"
  | "elapsed"
  | "trust"
  | "user"
  | "connections";
export type SortDir = "asc" | "desc";
export type FilterKey = "all" | "mine" | "system" | "untrusted" | "alerted" | "networked" | "new";

export const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "all" },
  { key: "mine", label: "mine" },
  { key: "system", label: "system" },
  { key: "untrusted", label: "unsigned or ad-hoc" },
  { key: "alerted", label: "alerted" },
  { key: "networked", label: "networked" },
  { key: "new", label: "new since baseline" },
];

/** Higher is more trusted. Pending sits with unknown so it never sorts as bad or good. */
export const TRUST_RANK: Record<TrustState, number> = {
  unsigned: 0,
  adhoc: 1,
  unknown: 2,
  pending: 2,
  "developer-id": 4,
  "app-store": 5,
  apple: 6,
};

export function sortProcesses(
  list: readonly ProcessInfo[],
  key: SortKey,
  dir: SortDir,
): ProcessInfo[] {
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: ProcessInfo, b: ProcessInfo): number => {
    switch (key) {
      case "command":
        return a.command.localeCompare(b.command, undefined, { sensitivity: "base" });
      case "user":
        return a.user.localeCompare(b.user);
      case "publisher":
        return (a.publisher ?? "").localeCompare(b.publisher ?? "", undefined, {
          sensitivity: "base",
        });
      case "path":
        return a.path.localeCompare(b.path);
      case "trust":
        return TRUST_RANK[a.trust] - TRUST_RANK[b.trust];
      default:
        return a[key] - b[key];
    }
  };
  // Stable: ties keep their incoming order (CPU descending from the server).
  return list
    .map((p, i) => ({ p, i }))
    .sort((x, y) => sign * cmp(x.p, y.p) || x.i - y.i)
    .map((x) => x.p);
}

export interface FilterOptions {
  filter: FilterKey;
  query: string;
  currentUser: string | null;
  alertedPids: ReadonlySet<number>;
}

const UNTRUSTED: ReadonlySet<TrustState> = new Set(["unsigned", "adhoc", "unknown"]);

export function filterProcesses(list: readonly ProcessInfo[], opts: FilterOptions): ProcessInfo[] {
  const q = opts.query.trim().toLowerCase();
  return list.filter((p) => {
    switch (opts.filter) {
      case "mine":
        if (opts.currentUser === null || p.user !== opts.currentUser) return false;
        break;
      case "system":
        if (!(p.trust === "apple" || p.user === "root" || p.user.startsWith("_"))) return false;
        break;
      case "untrusted":
        if (!UNTRUSTED.has(p.trust)) return false;
        break;
      case "alerted":
        if (!opts.alertedPids.has(p.pid)) return false;
        break;
      case "networked":
        if (p.connections === 0) return false;
        break;
      case "new":
        if (!p.newSinceBaseline) return false;
        break;
      default:
        break;
    }
    if (q.length === 0) return true;
    return (
      p.command.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q) ||
      (p.publisher?.toLowerCase().includes(q) ?? false) ||
      (p.bundleId?.toLowerCase().includes(q) ?? false) ||
      p.user.toLowerCase().includes(q) ||
      String(p.pid) === q
    );
  });
}

export function indexByPid(list: readonly ProcessInfo[]): Map<number, ProcessInfo> {
  const m = new Map<number, ProcessInfo>();
  for (const p of list) m.set(p.pid, p);
  return m;
}

/** Ancestors from the immediate parent up to the root. Cycle- and depth-guarded. */
export function parentChain(
  pid: number,
  byPid: ReadonlyMap<number, ProcessInfo>,
  maxDepth = 32,
): ProcessInfo[] {
  const chain: ProcessInfo[] = [];
  const seen = new Set<number>([pid]);
  let current = byPid.get(pid);
  while (current && chain.length < maxDepth) {
    const parent = byPid.get(current.ppid);
    if (!parent || seen.has(parent.pid)) break;
    chain.push(parent);
    seen.add(parent.pid);
    current = parent;
  }
  return chain;
}

export function childrenOf(pid: number, list: readonly ProcessInfo[]): ProcessInfo[] {
  return list.filter((p) => p.ppid === pid && p.pid !== pid);
}

/** The outermost `.app` bundle directory on the path, if any. */
export function bundleRoot(path: string): string | null {
  const m = path.match(/^(.*?\.app)(\/|$)/);
  return m ? m[1] : null;
}

/** The app a process belongs to: its bundle's name, else its own name. */
export function appOf(p: ProcessInfo): string {
  const root = bundleRoot(p.path);
  if (!root) return p.command;
  const base = root.split("/").pop() ?? root;
  return base.replace(/\.app$/, "");
}

export interface AppGroup {
  lead: ProcessInfo;
  /** The other processes of the same bundle, in list order. */
  members: ProcessInfo[];
  /** Totals across lead and members. */
  cpu: number;
  rss: number;
}

/**
 * Fold a list into app groups: processes sharing a .app bundle sit under the
 * first of them in list order (so the sort decides who leads), singletons
 * stay as they are. `order` is the full list with members right after their
 * lead; `memberOf` maps a member to its lead.
 */
export function groupByApp(list: readonly ProcessInfo[]): {
  order: ProcessInfo[];
  groups: Map<number, AppGroup>;
  memberOf: Map<number, number>;
} {
  const byRoot = new Map<string, ProcessInfo[]>();
  for (const p of list) {
    const root = bundleRoot(p.path);
    if (!root) continue;
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(p);
    else byRoot.set(root, [p]);
  }
  const order: ProcessInfo[] = [];
  const groups = new Map<number, AppGroup>();
  const memberOf = new Map<number, number>();
  const placed = new Set<number>();
  for (const p of list) {
    if (placed.has(p.pid)) continue;
    placed.add(p.pid);
    order.push(p);
    const root = bundleRoot(p.path);
    const bucket = root ? (byRoot.get(root) ?? []) : [];
    if (bucket.length < 2) continue;
    const members = bucket.filter((m) => m.pid !== p.pid && !placed.has(m.pid));
    if (members.length === 0) continue;
    groups.set(p.pid, {
      lead: p,
      members,
      cpu: members.reduce((s, m) => s + m.cpu, p.cpu),
      rss: members.reduce((s, m) => s + m.rss, p.rss),
    });
    for (const m of members) {
      placed.add(m.pid);
      memberOf.set(m.pid, p.pid);
      order.push(m);
    }
  }
  return { order, groups, memberOf };
}

export type LampState = "ok" | "caution" | "alarm" | "info" | "off";

export interface TrustLampInfo {
  state: LampState;
  /** Two or three words, shown beside the lamp. */
  label: string;
  /** One or two words for a narrow column. */
  short: string;
}

export function trustLamp(trust: TrustState): TrustLampInfo {
  switch (trust) {
    case "apple":
      return { state: "ok", label: "Apple system software", short: "Apple" };
    case "app-store":
      return { state: "ok", label: "From the App Store", short: "App Store" };
    case "developer-id":
      return { state: "ok", label: "Signed by an identified developer", short: "Signed" };
    case "adhoc":
      return { state: "caution", label: "Ad-hoc signature, no identity", short: "Ad-hoc" };
    case "unsigned":
      return { state: "alarm", label: "Not signed", short: "Unsigned" };
    case "pending":
      return { state: "off", label: "Checking signature", short: "Checking" };
    default:
      return { state: "off", label: "Signature unknown", short: "Unknown" };
  }
}

export type LocationKey =
  | "system"
  | "apps"
  | "user-apps"
  | "user-library"
  | "homebrew"
  | "downloads"
  | "temp"
  | "other"
  | "none";

export interface LocationInfo {
  key: LocationKey;
  label: string;
  /** True where code should rarely be running from (Downloads, temp). */
  flag: boolean;
}

export function locationClass(path: string, home = "/Users/"): LocationInfo {
  if (!path.startsWith("/")) return { key: "none", label: "no executable path", flag: false };
  if (/^\/(System|usr|bin|sbin|Library\/Apple)\//.test(path)) {
    return { key: "system", label: "macOS system location", flag: false };
  }
  if (path.startsWith("/Applications/"))
    return { key: "apps", label: "/Applications", flag: false };
  if (path.startsWith("/opt/homebrew/") || path.startsWith("/usr/local/")) {
    return { key: "homebrew", label: "Homebrew or /usr/local", flag: false };
  }
  if (/^\/(private\/)?(tmp|var\/folders)\//.test(path)) {
    return { key: "temp", label: "temporary directory", flag: true };
  }
  if (path.startsWith(home)) {
    if (/\/Downloads\//.test(path))
      return { key: "downloads", label: "Downloads folder", flag: true };
    if (/\/Applications\//.test(path))
      return { key: "user-apps", label: "user Applications", flag: false };
    if (/\/Library\//.test(path))
      return { key: "user-library", label: "user Library", flag: false };
    return { key: "other", label: "home folder", flag: false };
  }
  return { key: "other", label: "other location", flag: false };
}

/** One plain sentence about trust and origin, until the explainer layers land. */
export function explainTrust(p: ProcessInfo): string {
  const where = locationClass(p.path);
  const from = where.key === "none" ? "" : ` Runs from ${where.label}.`;
  switch (p.trust) {
    case "apple":
      return `Part of macOS, signed by Apple.${from}`;
    case "app-store":
      return `Installed from the App Store.${from}`;
    case "developer-id":
      return `Third-party software signed by ${p.publisher ?? "an identified developer"}.${from}`;
    case "adhoc":
      return `Signed ad-hoc: no publisher identity. Typical of Homebrew and local builds.${from}`;
    case "unsigned":
      return `Not code-signed. macOS cannot vouch for it.${from}${where.flag ? " That location is unusual for running code." : ""}`;
    case "pending":
      return `Signature check in progress.${from}`;
    default:
      return `Signature could not be determined.${from}`;
  }
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.round(seconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/**
 * The key a watch is stored under: the executable path. Null while the path
 * is still being resolved (or is a bare name), since a watch by name would
 * match any impostor with the same title.
 */
export function watchKey(p: Pick<ProcessInfo, "path">): string | null {
  return p.path.startsWith("/") ? p.path : null;
}
