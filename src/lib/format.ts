/** Shared formatting helpers — previously duplicated between route and page. */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0s";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const min = Math.floor(s / 60);
  const rem = s % 60;
  return `${min}m${rem > 0 ? ` ${rem}s` : ""}`;
}
