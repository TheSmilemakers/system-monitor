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

export interface TccService {
  service: string;
  name: string;
  highRisk: boolean;
}

export const TCC_SERVICES: TccService[] = [
  {
    service: "kTCCServiceAccessibility",
    name: "Accessibility (can observe keystrokes)",
    highRisk: true,
  },
  { service: "kTCCServiceScreenCapture", name: "Screen Recording", highRisk: true },
  { service: "kTCCServiceListenEvent", name: "Input Monitoring", highRisk: true },
  { service: "kTCCServiceSystemPolicyAllFiles", name: "Full Disk Access", highRisk: true },
  { service: "kTCCServiceCamera", name: "Camera", highRisk: false },
  { service: "kTCCServiceMicrophone", name: "Microphone", highRisk: false },
  { service: "kTCCServiceAddressBook", name: "Contacts", highRisk: false },
  { service: "kTCCServiceCalendar", name: "Calendar", highRisk: false },
  { service: "kTCCServicePhotos", name: "Photos", highRisk: false },
  { service: "kTCCServiceLocation", name: "Location", highRisk: false },
];

export interface PermissionGrant {
  service: string;
  name: string;
  highRisk: boolean;
  clients: string[];
}

export interface PermissionsReport {
  readable: boolean;
  grants: PermissionGrant[];
  highRiskGrants: number;
  unavailable: { check: string; reason: ProbeStatus }[];
  timestamp: number;
}

export function tccDatabasePath(): string {
  return `${os.homedir()}/Library/Application Support/com.apple.TCC/TCC.db`;
}

/** Grants for one service. `null` when the database could not be read. */
export async function grantsFor(service: string): Promise<string[] | null> {
  const res = await probe("sqlite3", [
    tccDatabasePath(),
    `SELECT client FROM access WHERE service='${service}' AND auth_value=2`,
  ]);
  if (!isOk(res)) return null;
  return res.value.split("\n").filter(Boolean);
}

export async function permissionsReport(now = Date.now()): Promise<PermissionsReport> {
  const grants: PermissionGrant[] = [];
  let readable = true;
  let highRiskGrants = 0;
  for (const svc of TCC_SERVICES) {
    const clients = await grantsFor(svc.service);
    if (clients === null) {
      readable = false;
      continue;
    }
    if (svc.highRisk) highRiskGrants += clients.length;
    grants.push({ service: svc.service, name: svc.name, highRisk: svc.highRisk, clients });
  }
  return {
    readable,
    grants,
    highRiskGrants,
    unavailable: readable ? [] : [{ check: "app permissions (TCC database)", reason: "denied" }],
    timestamp: now,
  };
}
