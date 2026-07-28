import { NextResponse } from "next/server";

import { CLEANUP_TARGETS, type CleanupTarget } from "@/lib/cleanup-targets";
import { assertLocalRequest, ForbiddenError } from "@/lib/guard";
import { finiteInt, probe, type ProbeStatus } from "@/lib/probe";
import { formatBytes } from "@/lib/format";
import { singleFlight } from "@/lib/single-flight";

/**
 * Disk cleanup scan.
 *
 * Targets are measured concurrently rather than in a synchronous loop: the
 * previous implementation ran `du` and `find` sequentially over ~15 directories
 * with `execSync`, blocking the whole process for 49-51 seconds (H-02).
 *
 * The response carries no executable command — only opaque ids (C-01).
 */

const SCAN_TIMEOUT_MS = 20_000;

export interface CleanupItemDTO {
  id: string;
  category: string;
  name: string;
  path: string;
  size: number;
  sizeFormatted: string;
  fileCount: number | null;
  description: string;
  risk: CleanupTarget["risk"];
  requiresRoot: boolean;
}

interface Measured {
  item: CleanupItemDTO | null;
  unavailable: { check: string; reason: ProbeStatus } | null;
}

async function measure(target: CleanupTarget): Promise<Measured> {
  const [sizeRes, countRes] = await Promise.all([
    probe("du", ["-sk", target.absPath], SCAN_TIMEOUT_MS),
    probe("find", [target.absPath, "-type", "f"], SCAN_TIMEOUT_MS),
  ]);

  if (sizeRes.status !== "ok") {
    // A timeout or denial previously became "" -> 0, dropping the item below the
    // size threshold so it vanished from the list without a word (H-03).
    return {
      item: null,
      unavailable: { check: `${target.name} (size)`, reason: sizeRes.status },
    };
  }

  const kb = finiteInt(sizeRes.value.split(/\s+/)[0], 0);
  const size = kb * 1024;
  if (size < target.minSize) return { item: null, unavailable: null };

  const fileCount =
    countRes.status === "ok" ? countRes.value.split("\n").filter(Boolean).length : null;

  return {
    item: {
      id: target.id,
      category: target.category,
      name: target.name,
      path: target.absPath,
      size,
      sizeFormatted: formatBytes(size),
      fileCount,
      description: target.description,
      risk: target.risk,
      requiresRoot: target.requiresRoot,
    },
    unavailable:
      countRes.status === "ok"
        ? null
        : { check: `${target.name} (file count)`, reason: countRes.status },
  };
}

async function scan() {
  const measured = await Promise.all(CLEANUP_TARGETS.map(measure));

  const items = measured
    .map((m) => m.item)
    .filter((i): i is CleanupItemDTO => i !== null)
    .sort((a, b) => b.size - a.size);

  const unavailable = measured
    .map((m) => m.unavailable)
    .filter((u): u is NonNullable<Measured["unavailable"]> => u !== null);

  const totalSize = items.reduce((s, i) => s + i.size, 0);

  return {
    items,
    unavailable,
    complete: unavailable.length === 0,
    totalSize,
    totalFormatted: formatBytes(totalSize),
    timestamp: Date.now(),
  };
}

export async function GET() {
  try {
    await assertLocalRequest();
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    throw e;
  }

  const data = await singleFlight("cleanup-scan", scan);
  return NextResponse.json(data);
}
