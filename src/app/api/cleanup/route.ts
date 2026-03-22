import { execSync } from "child_process";
import { NextResponse } from "next/server";

function run(cmd: string): string {
  try {
    return execSync(cmd, { timeout: 15000, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

function dirSize(path: string): number {
  const raw = run(`du -sk "${path}" 2>/dev/null | cut -f1`);
  return parseInt(raw || "0") * 1024; // KB to bytes
}

function fileCount(path: string): number {
  const raw = run(`find "${path}" -type f 2>/dev/null | wc -l`);
  return parseInt(raw || "0");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

interface CleanupItem {
  id: string;
  category: string;
  name: string;
  path: string;
  size: number;
  sizeFormatted: string;
  fileCount: number;
  description: string;
  risk: "safe" | "low" | "medium";
  command: string; // shell command to clean
}

export async function GET() {
  const home = process.env.HOME || "/Users/rajan";
  const items: CleanupItem[] = [];

  // --- Caches ---

  const cacheDirs = [
    { path: `${home}/Library/Caches`, name: "App Caches", desc: "Application caches — rebuilt automatically when needed" },
  ];

  for (const dir of cacheDirs) {
    const size = dirSize(dir.path);
    if (size > 1024 * 1024) { // >1MB
      items.push({
        id: dir.path.replace(/\//g, "_"),
        category: "Caches",
        name: dir.name,
        path: dir.path,
        size,
        sizeFormatted: formatBytes(size),
        fileCount: fileCount(dir.path),
        description: dir.desc,
        risk: "safe",
        command: `rm -rf "${dir.path}"/*`,
      });
    }
  }

  // Individual large cache subdirs
  const cacheSubdirs = run(`du -sk "${home}/Library/Caches"/* 2>/dev/null | sort -rn | head -10`);
  const largeCaches: { name: string; size: number; path: string }[] = [];
  for (const line of cacheSubdirs.split("\n").filter(Boolean)) {
    const [sizeKB, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    const size = parseInt(sizeKB) * 1024;
    if (size > 50 * 1024 * 1024) { // >50MB
      largeCaches.push({ name: path.split("/").pop() || path, size, path });
    }
  }

  // --- Logs ---

  const logDirs = [
    { path: `${home}/Library/Logs`, name: "User Logs", desc: "Application log files — safe to clear, apps create new ones" },
    { path: "/private/var/log", name: "System Logs", desc: "System log files — old logs are safe to remove (needs sudo)" },
  ];

  for (const dir of logDirs) {
    const size = dirSize(dir.path);
    if (size > 1024 * 1024) {
      items.push({
        id: dir.path.replace(/\//g, "_"),
        category: "Logs",
        name: dir.name,
        path: dir.path,
        size,
        sizeFormatted: formatBytes(size),
        fileCount: fileCount(dir.path),
        description: dir.desc,
        risk: dir.path.startsWith("/private") ? "low" : "safe",
        command: dir.path.startsWith("/private")
          ? `sudo rm -rf "${dir.path}"/*.log "${dir.path}"/*.gz`
          : `rm -rf "${dir.path}"/*`,
      });
    }
  }

  // --- Trash ---

  const trashPath = `${home}/.Trash`;
  const trashSize = dirSize(trashPath);
  if (trashSize > 1024 * 1024) {
    items.push({
      id: "trash",
      category: "Trash",
      name: "Trash",
      path: trashPath,
      size: trashSize,
      sizeFormatted: formatBytes(trashSize),
      fileCount: fileCount(trashPath),
      description: "Files you've already deleted — sitting in Trash using disk space",
      risk: "safe",
      command: `rm -rf "${trashPath}"/*`,
    });
  }

  // --- Downloads (old files) ---

  const dlPath = `${home}/Downloads`;
  // Files older than 30 days
  const oldDlCount = parseInt(run(`find "${dlPath}" -maxdepth 1 -type f -mtime +30 2>/dev/null | wc -l`) || "0");
  const oldDlSize = parseInt(run(`find "${dlPath}" -maxdepth 1 -type f -mtime +30 -exec du -sk {} + 2>/dev/null | awk '{s+=$1}END{print s}'`) || "0") * 1024;
  if (oldDlSize > 1024 * 1024) {
    items.push({
      id: "old_downloads",
      category: "Downloads",
      name: "Old Downloads (30+ days)",
      path: dlPath,
      size: oldDlSize,
      sizeFormatted: formatBytes(oldDlSize),
      fileCount: oldDlCount,
      description: "Files in Downloads older than 30 days — review before deleting",
      risk: "medium",
      command: `find "${dlPath}" -maxdepth 1 -type f -mtime +30 -delete`,
    });
  }

  // --- Developer Caches ---

  const devDirs = [
    { path: `${home}/Library/Developer/Xcode/DerivedData`, name: "Xcode DerivedData", desc: "Xcode build artifacts — rebuilt on next build" },
    { path: `${home}/Library/Developer/Xcode/Archives`, name: "Xcode Archives", desc: "Old app archives — safe if you don't need to re-submit old builds" },
    { path: `${home}/Library/Developer/CoreSimulator/Caches`, name: "iOS Simulator Caches", desc: "Simulator caches — rebuilt automatically" },
    { path: `${home}/.bun/install/cache`, name: "Bun Cache", desc: "Bun package cache — packages re-downloaded when needed" },
    { path: `${home}/.npm/_cacache`, name: "npm Cache", desc: "npm package cache — packages re-downloaded when needed" },
    { path: `${home}/.cache/yarn`, name: "Yarn Cache", desc: "Yarn package cache — packages re-downloaded when needed" },
    { path: `${home}/Library/Caches/pnpm`, name: "pnpm Cache", desc: "pnpm package cache — packages re-downloaded when needed" },
    { path: `${home}/.cache/pip`, name: "pip Cache", desc: "Python pip cache — packages re-downloaded when needed" },
    { path: `${home}/Library/Caches/Homebrew`, name: "Homebrew Cache", desc: "Downloaded formula archives — safe to clear" },
    { path: `${home}/Library/Caches/CocoaPods`, name: "CocoaPods Cache", desc: "Pod spec cache — rebuilt on next install" },
  ];

  for (const dir of devDirs) {
    const size = dirSize(dir.path);
    if (size > 10 * 1024 * 1024) { // >10MB
      items.push({
        id: dir.path.replace(/\//g, "_"),
        category: "Developer",
        name: dir.name,
        path: dir.path,
        size,
        sizeFormatted: formatBytes(size),
        fileCount: fileCount(dir.path),
        description: dir.desc,
        risk: "safe",
        command: `rm -rf "${dir.path}"/*`,
      });
    }
  }

  // --- Crash Reports ---

  const crashDirs = [
    { path: `${home}/Library/Logs/DiagnosticReports`, name: "Crash Reports", desc: "App crash logs — safe to delete unless debugging a crash" },
    { path: "/Library/Logs/DiagnosticReports", name: "System Crash Reports", desc: "System crash logs" },
  ];

  for (const dir of crashDirs) {
    const size = dirSize(dir.path);
    if (size > 1024 * 1024) {
      items.push({
        id: dir.path.replace(/\//g, "_"),
        category: "Crash Reports",
        name: dir.name,
        path: dir.path,
        size,
        sizeFormatted: formatBytes(size),
        fileCount: fileCount(dir.path),
        description: dir.desc,
        risk: "safe",
        command: `rm -rf "${dir.path}"/*`,
      });
    }
  }

  // --- iOS Backups ---

  const backupPath = `${home}/Library/Application Support/MobileSync/Backup`;
  const backupSize = dirSize(backupPath);
  if (backupSize > 100 * 1024 * 1024) {
    items.push({
      id: "ios_backups",
      category: "Backups",
      name: "iOS Device Backups",
      path: backupPath,
      size: backupSize,
      sizeFormatted: formatBytes(backupSize),
      fileCount: fileCount(backupPath),
      description: "Local iPhone/iPad backups — safe if you use iCloud backup instead",
      risk: "medium",
      command: `rm -rf "${backupPath}"/*`,
    });
  }

  // --- Mail Downloads ---

  const mailDlPath = `${home}/Library/Containers/com.apple.mail/Data/Library/Mail Downloads`;
  const mailDlSize = dirSize(mailDlPath);
  if (mailDlSize > 10 * 1024 * 1024) {
    items.push({
      id: "mail_downloads",
      category: "Mail",
      name: "Mail Attachment Downloads",
      path: mailDlPath,
      size: mailDlSize,
      sizeFormatted: formatBytes(mailDlSize),
      fileCount: fileCount(mailDlPath),
      description: "Cached email attachments — re-downloaded from server when needed",
      risk: "safe",
      command: `rm -rf "${mailDlPath}"/*`,
    });
  }

  // Sort by size descending
  items.sort((a, b) => b.size - a.size);

  const totalSize = items.reduce((s, i) => s + i.size, 0);

  return NextResponse.json({
    items,
    largeCaches,
    totalSize,
    totalFormatted: formatBytes(totalSize),
    timestamp: Date.now(),
  });
}
