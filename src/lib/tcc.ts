import os from "node:os";

import { isOk, probe, type ProbeStatus } from "./probe";

/**
 * Privacy permissions (TCC): which apps hold which grants.
 *
 * Read from the user's TCC database with sqlite3, one query per service.
 * Without Full Disk Access the database is unreadable; that is reported as
 * such, never as "no grants". Shared by the privacy scan and the
 * Permissions view.
 */

export type TccScope = "user" | "system";

export interface TccService {
  service: string;
  name: string;
  highRisk: boolean;
  /** Which database records the grant: the user's, or the system-wide one under /Library. */
  scope: TccScope;
}

export const TCC_SERVICES: TccService[] = [
  {
    service: "kTCCServiceAccessibility",
    name: "Accessibility (can observe keystrokes)",
    highRisk: true,
    scope: "system",
  },
  {
    service: "kTCCServiceScreenCapture",
    name: "Screen Recording",
    highRisk: true,
    scope: "system",
  },
  { service: "kTCCServiceListenEvent", name: "Input Monitoring", highRisk: true, scope: "system" },
  {
    service: "kTCCServiceSystemPolicyAllFiles",
    name: "Full Disk Access",
    highRisk: true,
    scope: "system",
  },
  { service: "kTCCServiceCamera", name: "Camera", highRisk: false, scope: "user" },
  { service: "kTCCServiceMicrophone", name: "Microphone", highRisk: false, scope: "user" },
  { service: "kTCCServiceAddressBook", name: "Contacts", highRisk: false, scope: "user" },
  { service: "kTCCServiceCalendar", name: "Calendar", highRisk: false, scope: "user" },
  { service: "kTCCServicePhotos", name: "Photos", highRisk: false, scope: "user" },
  { service: "kTCCServiceLocation", name: "Location", highRisk: false, scope: "user" },
];

export interface PermissionGrant {
  service: string;
  name: string;
  highRisk: boolean;
  /** False when that service's database could not be read: the clients are then unknown, not none. */
  readable: boolean;
  clients: string[];
}

export interface PermissionsReport {
  readable: boolean;
  grants: PermissionGrant[];
  highRiskGrants: number;
  unavailable: { check: string; reason: ProbeStatus }[];
  timestamp: number;
}

export function tccDatabasePath(scope: TccScope = "user"): string {
  return scope === "system"
    ? "/Library/Application Support/com.apple.TCC/TCC.db"
    : `${os.homedir()}/Library/Application Support/com.apple.TCC/TCC.db`;
}

/**
 * Grants for one service, from the database that records it. `null` when
 * that database could not be read. Accessibility, Screen Recording, Input
 * Monitoring and Full Disk Access are system-wide and live under /Library,
 * readable only with Full Disk Access; reading the user's database alone
 * would report them as empty, which is not the same as none.
 */
export async function grantsFor(
  service: string,
  scope: TccScope = TCC_SERVICES.find((s) => s.service === service)?.scope ?? "user",
): Promise<string[] | null> {
  const res = await probe("sqlite3", [
    tccDatabasePath(scope),
    `SELECT client FROM access WHERE service='${service}' AND auth_value=2`,
  ]);
  if (!isOk(res)) return null;
  return res.value.split("\n").filter(Boolean);
}

export async function permissionsReport(now = Date.now()): Promise<PermissionsReport> {
  const grants: PermissionGrant[] = [];
  const denied: Record<TccScope, boolean> = { user: false, system: false };
  let highRiskGrants = 0;
  for (const svc of TCC_SERVICES) {
    const clients = await grantsFor(svc.service, svc.scope);
    if (clients === null) denied[svc.scope] = true;
    if (clients && svc.highRisk) highRiskGrants += clients.length;
    grants.push({
      service: svc.service,
      name: svc.name,
      highRisk: svc.highRisk,
      readable: clients !== null,
      clients: clients ?? [],
    });
  }
  const unavailable: PermissionsReport["unavailable"] = [];
  if (denied.user) unavailable.push({ check: "app permissions (TCC database)", reason: "denied" });
  if (denied.system)
    unavailable.push({
      check: "system-level permissions (system TCC database, needs Full Disk Access)",
      reason: "denied",
    });
  return {
    // Readable means the user's own database opened; system-level rows say for themselves.
    readable: !denied.user,
    grants,
    highRiskGrants,
    unavailable,
    timestamp: now,
  };
}
