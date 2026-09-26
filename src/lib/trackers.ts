/**
 * Known tracker and telemetry hostnames, matched as substrings of a resolved
 * hostname. Shared by the privacy scan and the Network view.
 */

export interface TrackerInfo {
  category: string;
  description: string;
  severity: "high" | "medium" | "low";
}

export const KNOWN_TRACKERS: Record<string, TrackerInfo> = {
  "google-analytics": {
    category: "Analytics",
    description: "Google Analytics",
    severity: "medium",
  },
  googleads: { category: "Ads", description: "Google Ads", severity: "high" },
  doubleclick: { category: "Ads", description: "Google DoubleClick", severity: "high" },
  "graph.facebook": { category: "Social", description: "Facebook Graph API", severity: "high" },
  facebook: { category: "Social", description: "Facebook/Meta", severity: "high" },
  fbcdn: { category: "Social", description: "Facebook CDN", severity: "medium" },
  crashlytics: {
    category: "Crash Reporting",
    description: "Firebase Crashlytics",
    severity: "low",
  },
  "app-measurement": {
    category: "Analytics",
    description: "Firebase Analytics",
    severity: "medium",
  },
  amplitude: { category: "Analytics", description: "Amplitude", severity: "medium" },
  mixpanel: { category: "Analytics", description: "Mixpanel", severity: "medium" },
  segment: { category: "Analytics", description: "Segment", severity: "medium" },
  sentry: { category: "Error Tracking", description: "Sentry", severity: "low" },
  hotjar: { category: "Session Recording", description: "Hotjar", severity: "high" },
  fullstory: { category: "Session Recording", description: "FullStory", severity: "high" },
  mouseflow: { category: "Session Recording", description: "Mouseflow", severity: "high" },
  smartlook: { category: "Session Recording", description: "Smartlook", severity: "high" },
  appsflyer: { category: "Attribution", description: "AppsFlyer", severity: "medium" },
  adjust: { category: "Attribution", description: "Adjust", severity: "medium" },
  branch: { category: "Attribution", description: "Branch", severity: "medium" },
  newrelic: { category: "APM", description: "New Relic", severity: "low" },
  datadog: { category: "APM", description: "Datadog", severity: "low" },
  scorecardresearch: { category: "Analytics", description: "comScore", severity: "medium" },
  quantserve: { category: "Analytics", description: "Quantcast", severity: "medium" },
  tiktok: { category: "Social", description: "TikTok", severity: "high" },
  bytedance: { category: "Social", description: "ByteDance", severity: "high" },
  snapchat: { category: "Social", description: "Snapchat", severity: "medium" },
};

export const APPLE_TELEMETRY = ["xp.apple.com", "metrics.apple.com", "diagnostics.apple.com"];

/** The first tracker whose pattern appears in the hostname, if any. */
export function matchTracker(hostname: string): (TrackerInfo & { pattern: string }) | null {
  const host = hostname.toLowerCase();
  for (const [pattern, info] of Object.entries(KNOWN_TRACKERS)) {
    if (host.includes(pattern)) return { ...info, pattern };
  }
  return null;
}

export function isAppleTelemetry(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return APPLE_TELEMETRY.some((d) => host.includes(d));
}
