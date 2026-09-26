"use client";

import type { SystemStats } from "@/lib/schemas";
import { SCOPE_WINDOW_MS, sliceWindow } from "@/lib/scope-model";

import { LedMeter, levelFor, type Level } from "./led-meter";
import { Vital } from "./vital";

export interface Levels {
  cpu: Level;
  mem: Level;
  swap: Level;
  load: Level;
  disk: Level;
}

export function computeLevels(data: SystemStats): Levels {
  return {
    cpu: levelFor(data.cpu.used, 60, 85),
    mem: levelFor(data.memory.percent, 70, 90),
    swap: data.swap.usedMB > 2000 ? "critical" : data.swap.usedMB > 100 ? "warn" : "ok",
    load: levelFor(data.load[0] ?? 0, data.cpu.cores * 0.8, data.cpu.cores * 1.2),
    disk: levelFor(data.disk.percent, 80, 95),
  };
}

function swapText(usedMB: number): string {
  return usedMB < 1024 ? `${usedMB}` : (usedMB / 1024).toFixed(1);
}

/** Four instruments stacked like a rack, then disk as a single meter. */
export function VitalsRail({ data, levels }: { data: SystemStats; levels: Levels }) {
  const history = sliceWindow(data.history, null, SCOPE_WINDOW_MS);
  return (
    <div className="flex flex-col gap-2" aria-label="System vitals">
      <Vital
        label="CPU"
        level={levels.cpu}
        value={data.cpu.used.toFixed(1)}
        unit="%"
        breakdown={`${data.cpu.user.toFixed(0)}% user  ${data.cpu.system.toFixed(0)}% sys  ${data.cpu.idle.toFixed(0)}% idle`}
        meter={{ value: data.cpu.used, max: 100, warnAt: 60, critAt: 85 }}
        trace={{ data: history.map((h) => h.cpu), max: 100, unit: "%", warnAt: 60, critAt: 85 }}
      />
      <Vital
        label="Memory"
        level={levels.mem}
        value={data.memory.usedGB.toFixed(1)}
        unit={`of ${data.memory.totalGB} GB`}
        breakdown={`${data.memory.wiredGB} GB wired  ${data.memory.compressorGB} GB compressed  ${data.memory.percent}%`}
        meter={{ value: data.memory.percent, max: 100, warnAt: 70, critAt: 90 }}
        trace={{ data: history.map((h) => h.mem), max: 100, unit: "%", warnAt: 70, critAt: 90 }}
      />
      <Vital
        label="Swap"
        level={levels.swap}
        value={swapText(data.swap.usedMB)}
        unit={data.swap.usedMB < 1024 ? "MB" : "GB"}
        breakdown={
          data.swap.totalMB > 0
            ? `${data.swap.totalMB} MB allocated  ${data.swap.percent}%`
            : "none allocated"
        }
        meter={{
          value: data.swap.usedMB,
          max: Math.max(data.swap.totalMB, 1),
          warnAt: 100,
          critAt: 2000,
        }}
        trace={{
          data: history.map((h) => h.swap),
          max: 4096,
          unit: "MB",
          warnAt: 100,
          critAt: 2000,
        }}
      />
      <Vital
        label="Load"
        level={levels.load}
        value={(data.load[0] ?? 0).toFixed(1)}
        unit={`${data.cpu.cores} cores`}
        breakdown={`1m ${(data.load[0] ?? 0).toFixed(1)}  5m ${(data.load[1] ?? 0).toFixed(1)}  15m ${(data.load[2] ?? 0).toFixed(1)}`}
        meter={{
          value: data.load[0] ?? 0,
          max: data.cpu.cores * 2,
          warnAt: data.cpu.cores * 0.8,
          critAt: data.cpu.cores * 1.2,
        }}
        trace={{
          data: history.map((h) => h.load),
          max: data.cpu.cores * 2,
          warnAt: data.cpu.cores * 0.8,
          critAt: data.cpu.cores * 1.2,
        }}
      />
      <section
        aria-label={`Disk, ${data.disk.percent}% used`}
        className="rounded-md border border-border bg-card px-3 py-2.5"
      >
        <h2 className="engraved flex items-center justify-between">
          <span>Disk</span>
          <span className="font-mono text-[11px] tabular-nums normal-case tracking-normal text-muted-foreground">
            {data.disk.used} of {data.disk.total}
          </span>
        </h2>
        <div className="mt-2">
          <LedMeter
            value={data.disk.percent}
            max={100}
            warnAt={80}
            critAt={95}
            label="Disk meter"
          />
        </div>
      </section>
    </div>
  );
}
