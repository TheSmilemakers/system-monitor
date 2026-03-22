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
