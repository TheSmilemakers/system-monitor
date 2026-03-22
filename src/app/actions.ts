"use server";

import { execSync } from "child_process";

export async function stopServer(): Promise<{ success: boolean; error?: string }> {
  try {
    execSync("kill $(lsof -ti :3000) 2>/dev/null", { encoding: "utf-8" });
    return { success: true };
  } catch {
    return { success: false, error: "Server may have already stopped" };
  }
}

// Allowlist of safe cleanup commands — only these patterns can run
const SAFE_CLEANUP_PATTERNS = [
  /^rm -rf ".*\/(Library\/Caches|Library\/Logs|\.Trash|Library\/Developer|\.bun\/install\/cache|\.npm\/_cacache|\.cache\/yarn|\.cache\/pip|Library\/Caches\/Homebrew|Library\/Caches\/CocoaPods|Library\/Caches\/pnpm|Library\/Logs\/DiagnosticReports|MobileSync\/Backup|Mail Downloads)"\/?\*$/,
  /^find ".*\/Downloads" -maxdepth 1 -type f -mtime \+30 -delete$/,
  /^sudo rm -rf ".*\/(var\/log)\/\*\.(log|gz)"$/,
];

export async function cleanupItem(command: string): Promise<{ success: boolean; error?: string }> {
  // Validate command against allowlist
  const isSafe = SAFE_CLEANUP_PATTERNS.some((p) => p.test(command));
  if (!isSafe) {
    return { success: false, error: "Command not in safe cleanup allowlist" };
  }

  // Block commands requiring sudo (user must run those manually)
  if (command.startsWith("sudo")) {
    return { success: false, error: "This cleanup requires sudo — run manually in terminal" };
  }

  try {
    execSync(command, { encoding: "utf-8", timeout: 30000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: "Cleanup failed — some files may be in use" };
  }
}

export async function killProcess(pid: number): Promise<{ success: boolean; error?: string }> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { success: false, error: "Invalid PID" };
  }

  // Don't allow killing critical system processes
  const protected_pids = [0, 1];
  if (protected_pids.includes(pid)) {
    return { success: false, error: "Cannot kill protected system process" };
  }

  try {
    // Verify the process belongs to the current user before killing
    const owner = execSync(`ps -o user= -p ${pid} 2>/dev/null`, { encoding: "utf-8" }).trim();
    const currentUser = execSync("whoami", { encoding: "utf-8" }).trim();

    if (owner !== currentUser) {
      return { success: false, error: `Process owned by '${owner}', not '${currentUser}'. Use sudo to kill system processes.` };
    }

    execSync(`kill -15 ${pid} 2>/dev/null`);
    return { success: true };
  } catch {
    // Process may have already exited
    try {
      execSync(`ps -p ${pid} 2>/dev/null`);
      // Still running, try force kill
      try {
        execSync(`kill -9 ${pid} 2>/dev/null`);
        return { success: true };
      } catch {
        return { success: false, error: "Failed to force kill process" };
      }
    } catch {
      // Process no longer exists
      return { success: true };
    }
  }
}
