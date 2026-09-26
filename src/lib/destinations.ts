/**
 * Destinations as the monitor should remember them. Content networks and
 * clouds answer from a different address every session, and their reverse
 * names carry the address inside them, so "new outbound destination" fired
 * for every one and drowned the timeline. A destination folds to its owner's
 * pattern (every Akamai edge is one subject, every Apple CDN node is one),
 * an unresolved address folds to its /24 or /48, and a known owner turns the
 * event into information rather than a caution. Pure; shared by the monitor,
 * the network view and the report.
 */

export interface CanonicalDestination {
  /** The subject the monitor compares: a pattern, a prefix, or the host itself. */
  key: string;
  /** Who runs it, when the name or the address block says. */
  owner: string | null;
}

const OWNED: { test: RegExp; owner: string; key: string }[] = [
  { test: /(^|\.)aaplimg\.com$/, owner: "Apple CDN", key: "*.aaplimg.com" },
  { test: /(^|\.)cdn-apple\.com$/, owner: "Apple CDN", key: "*.cdn-apple.com" },
  { test: /(^|\.)apple-dns\.net$/, owner: "Apple", key: "*.apple-dns.net" },
  { test: /(^|\.)icloud\.com$/, owner: "Apple iCloud", key: "*.icloud.com" },
  { test: /(^|\.)apple\.com$/, owner: "Apple", key: "*.apple.com" },
  { test: /(^|\.)akamaitechnologies\.com$/, owner: "Akamai CDN", key: "*.akamaitechnologies.com" },
  { test: /(^|\.)akamaiedge\.net$/, owner: "Akamai CDN", key: "*.akamaiedge.net" },
  { test: /(^|\.)akamai\.net$/, owner: "Akamai CDN", key: "*.akamai.net" },
  { test: /(^|\.)1e100\.net$/, owner: "Google", key: "*.1e100.net" },
  { test: /(^|\.)googleusercontent\.com$/, owner: "Google Cloud", key: "*.googleusercontent.com" },
  { test: /(^|\.)google\.com$/, owner: "Google", key: "*.google.com" },
  { test: /(^|\.)googleapis\.com$/, owner: "Google", key: "*.googleapis.com" },
  { test: /(^|\.)gstatic\.com$/, owner: "Google", key: "*.gstatic.com" },
  { test: /(^|\.)amazonaws\.com$/, owner: "Amazon Web Services", key: "*.amazonaws.com" },
  { test: /(^|\.)cloudfront\.net$/, owner: "Amazon CloudFront", key: "*.cloudfront.net" },
  { test: /(^|\.)github\.com$/, owner: "GitHub", key: "*.github.com" },
  { test: /(^|\.)githubusercontent\.com$/, owner: "GitHub", key: "*.githubusercontent.com" },
  { test: /(^|\.)cloudflare\.com$/, owner: "Cloudflare", key: "*.cloudflare.com" },
  { test: /(^|\.)cloudflare-dns\.com$/, owner: "Cloudflare", key: "*.cloudflare-dns.com" },
  { test: /(^|\.)fastly(lb)?\.net$/, owner: "Fastly CDN", key: "*.fastly.net" },
  { test: /(^|\.)edgecastcdn\.net$/, owner: "Edgecast CDN", key: "*.edgecastcdn.net" },
  { test: /(^|\.)azureedge\.net$/, owner: "Microsoft Azure", key: "*.azureedge.net" },
  { test: /(^|\.)trafficmanager\.net$/, owner: "Microsoft Azure", key: "*.trafficmanager.net" },
  { test: /(^|\.)microsoft\.com$/, owner: "Microsoft", key: "*.microsoft.com" },
  { test: /(^|\.)msedge\.net$/, owner: "Microsoft", key: "*.msedge.net" },
  { test: /(^|\.)office\.(net|com)$/, owner: "Microsoft 365", key: "*.office.net" },
  { test: /(^|\.)slack(-edge)?\.com$/, owner: "Slack", key: "*.slack.com" },
  { test: /(^|\.)anthropic\.com$/, owner: "Anthropic", key: "*.anthropic.com" },
  { test: /(^|\.)openai\.com$/, owner: "OpenAI", key: "*.openai.com" },
  { test: /(^|\.)(spotify\.com|scdn\.co)$/, owner: "Spotify", key: "*.spotify.com" },
  { test: /(^|\.)nordvpn\.com$/, owner: "NordVPN", key: "*.nordvpn.com" },
  { test: /(^|\.)(facebook\.com|fbcdn\.net)$/, owner: "Meta", key: "*.facebook.com" },
  { test: /(^|\.)whatsapp\.net$/, owner: "WhatsApp", key: "*.whatsapp.net" },
  { test: /(^|\.)discord(app)?\.com$/, owner: "Discord", key: "*.discord.com" },
  { test: /(^|\.)vercel\.app$/, owner: "Vercel", key: "*.vercel.app" },
];

/** Address blocks whose owner is public knowledge; the rest stay anonymous. */
const PREFIX_OWNERS: { test: RegExp; owner: string }[] = [
  { test: /^17\./, owner: "Apple" },
  { test: /^2a01:b740:/, owner: "Apple" },
  { test: /^2620:149:/, owner: "Apple" },
  { test: /^(2607:f8b0|2001:4860|2a00:1450|2404:6800|2800:3f0):/, owner: "Google" },
  { test: /^2600:1901:/, owner: "Google Cloud" },
  { test: /^2603:10/, owner: "Microsoft" },
  { test: /^(2620:1ec|2a01:111):/, owner: "Microsoft" },
  { test: /^13\.107\./, owner: "Microsoft" },
  { test: /^(2606:4700|2a06:98c[01]):/, owner: "Cloudflare" },
  { test: /^104\.(1[6-9]|2[0-9]|3[01])\./, owner: "Cloudflare" },
  { test: /^2a04:4e42:/, owner: "Fastly CDN" },
  { test: /^151\.101\./, owner: "Fastly CDN" },
  { test: /^2a03:2880:/, owner: "Meta" },
  { test: /^2a02:26f0:/, owner: "Akamai CDN" },
];

function isPrivate(ip: string): boolean {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("127.") ||
    ip === "::1" ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    ip.startsWith("fe80:") ||
    ip.startsWith("fd") ||
    ip.startsWith("169.254.")
  );
}

const isIp = (s: string) => /^[0-9.]+$/.test(s) || (s.includes(":") && /^[0-9a-f:.]+$/.test(s));

/** An unresolved address folds to its block: /24 for v4, /48 for v6. */
function foldIp(ip: string): string {
  if (ip.includes(":")) {
    const groups = ip.split("::")[0]?.split(":").filter(Boolean) ?? [];
    return `${groups.slice(0, 3).join(":")}::/48`;
  }
  return `${ip.split(".").slice(0, 3).join(".")}.0/24`;
}

export function ownerOf(hostOrKey: string): string | null {
  const h = hostOrKey.trim().toLowerCase().replace(/\.$/, "");
  const bare = h.replace(/\/\d+$/, "").replace(/::$/, ":");
  if (isIp(bare) || bare.endsWith(":")) {
    return PREFIX_OWNERS.find((p) => p.test.test(bare))?.owner ?? null;
  }
  return OWNED.find((o) => o.test.test(h))?.owner ?? null;
}

export function canonicalDestination(host: string): CanonicalDestination {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h.length === 0) return { key: h, owner: null };
  if (h.includes("/")) return { key: h, owner: ownerOf(h) }; // already a key
  if (isIp(h)) {
    if (isPrivate(h)) return { key: h, owner: null };
    return { key: foldIp(h), owner: ownerOf(h) };
  }
  const owned = OWNED.find((o) => o.test.test(h));
  if (owned) return { key: owned.key, owner: owned.owner };
  return { key: h, owner: null };
}
