"use client";

import { useEffect, useState, useCallback, useTransition } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import { killProcess, stopServer } from "./actions";

interface SystemStats {
  cpu: { user: number; system: number; idle: number; used: number; model: string; cores: number };
  load: number[];
  memory: { totalGB: number; usedGB: number; freeGB: number; percent: number; wiredGB: number; compressorGB: number };
  swap: { totalMB: number; usedMB: number; percent: number };
  disk: { total: string; used: string; available: string; percent: number };
  processes: { total: number; threads: number; top: ProcessInfo[] };
  uptime: string;
  battery: { percent: number; charging: boolean } | null;
  timestamp: number;
}

interface ProcessInfo {
  user: string;
  pid: number;
  cpu: number;
  mem: number;
  rss: number;
  command: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function StatusDot({ level }: { level: "ok" | "warn" | "critical" }) {
  const colors = {
    ok: "bg-emerald-500 shadow-emerald-500/50",
    warn: "bg-amber-500 shadow-amber-500/50",
    critical: "bg-red-500 shadow-red-500/50 animate-pulse",
  };
  return <span className={`inline-block w-2 h-2 rounded-full shadow-sm ${colors[level]}`} />;
}

function getLevel(value: number, warn: number, critical: number): "ok" | "warn" | "critical" {
  if (value >= critical) return "critical";
  if (value >= warn) return "warn";
  return "ok";
}

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full transition-all duration-500 ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState(3000);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [killMessage, setKillMessage] = useState<{ pid: number; success: boolean; error?: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      setStats(data);
      setError(null);
    } catch {
      setError("Failed to fetch system stats");
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, refreshInterval);
    return () => clearInterval(id);
  }, [fetchStats, refreshInterval]);

  const handleKill = (pid: number, name: string) => {
    if (!confirm(`Kill process "${name}" (PID ${pid})?`)) return;
    setKillingPid(pid);
    startTransition(async () => {
      const result = await killProcess(pid);
      setKillMessage({ pid, ...result });
      setKillingPid(null);
      setTimeout(() => setKillMessage(null), 3000);
    });
  };

  if (!stats) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-muted-foreground font-mono text-sm animate-pulse">Loading system stats...</div>
      </div>
    );
  }

  const memLevel = getLevel(stats.memory.percent, 70, 90);
  const cpuLevel = getLevel(stats.cpu.used, 60, 85);
  const swapLevel = stats.swap.usedMB > 100 ? (stats.swap.usedMB > 2000 ? "critical" : "warn") : "ok";
  const loadLevel = getLevel(stats.load[0], stats.cpu.cores * 0.8, stats.cpu.cores * 1.2);
  const diskLevel = getLevel(stats.disk.percent, 80, 95);

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold tracking-tight font-mono">System Monitor</h1>
          <Badge variant="outline" className="font-mono text-xs">{stats.cpu.model}</Badge>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
          <span>up {stats.uptime}</span>
          {stats.battery && (
            <span>{stats.battery.charging ? "AC" : "BAT"} {stats.battery.percent}%</span>
          )}
          <span>{stats.processes.total} procs / {stats.processes.threads} threads</span>
          <select
            value={refreshInterval}
            onChange={(e) => setRefreshInterval(Number(e.target.value))}
            className="bg-muted border border-border rounded px-2 py-0.5 text-xs"
          >
            <option value={1000}>1s</option>
            <option value={3000}>3s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
          </select>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs font-mono text-red-400 hover:text-red-300 hover:bg-red-500/10"
            onClick={async () => {
              if (!confirm("Stop the System Monitor server?")) return;
              await stopServer();
            }}
          >
            Stop Server
          </Button>
        </div>
      </header>

      {/* Kill feedback */}
      {killMessage && (
        <div className={`mx-6 mt-3 px-3 py-2 rounded text-xs font-mono ${killMessage.success ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}>
          {killMessage.success ? `Killed PID ${killMessage.pid}` : `Failed to kill PID ${killMessage.pid}: ${killMessage.error}`}
        </div>
      )}

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 rounded bg-red-500/10 text-red-400 border border-red-500/20 text-xs font-mono">
          {error}
        </div>
      )}

      <main className="p-6 space-y-4">
        {/* Stats Cards Row */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {/* CPU */}
          <Card className="border-border">
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={cpuLevel} /> CPU
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-2">
              <div className="text-2xl font-mono font-bold tabular-nums">{stats.cpu.used.toFixed(1)}%</div>
              <MiniBar value={stats.cpu.used} max={100} color={cpuLevel === "critical" ? "bg-red-500" : cpuLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              <div className="text-xs text-muted-foreground font-mono">
                {stats.cpu.user.toFixed(0)}% usr / {stats.cpu.system.toFixed(0)}% sys
              </div>
            </CardContent>
          </Card>

          {/* Memory */}
          <Card className="border-border">
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={memLevel} /> Memory
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-2">
              <div className="text-2xl font-mono font-bold tabular-nums">{stats.memory.usedGB}G <span className="text-sm text-muted-foreground">/ {stats.memory.totalGB}G</span></div>
              <MiniBar value={stats.memory.usedGB} max={stats.memory.totalGB} color={memLevel === "critical" ? "bg-red-500" : memLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              <div className="text-xs text-muted-foreground font-mono">
                {stats.memory.wiredGB}G wired / {stats.memory.compressorGB}G compressed
              </div>
            </CardContent>
          </Card>

          {/* Swap */}
          <Card className="border-border">
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={swapLevel} /> Swap
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-2">
              <div className="text-2xl font-mono font-bold tabular-nums">
                {stats.swap.usedMB < 1024 ? `${stats.swap.usedMB}M` : `${(stats.swap.usedMB / 1024).toFixed(1)}G`}
              </div>
              {stats.swap.totalMB > 0 ? (
                <MiniBar value={stats.swap.usedMB} max={stats.swap.totalMB} color={swapLevel === "critical" ? "bg-red-500" : swapLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              ) : (
                <div className="h-2 w-full rounded-full bg-muted" />
              )}
              <div className="text-xs text-muted-foreground font-mono">
                {stats.swap.totalMB > 0 ? `${stats.swap.totalMB}M total` : "None allocated"}
              </div>
            </CardContent>
          </Card>

          {/* Load */}
          <Card className="border-border">
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={loadLevel} /> Load
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-2">
              <div className="text-2xl font-mono font-bold tabular-nums">{stats.load[0].toFixed(1)}</div>
              <MiniBar value={stats.load[0]} max={stats.cpu.cores * 2} color={loadLevel === "critical" ? "bg-red-500" : loadLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              <div className="text-xs text-muted-foreground font-mono">
                {stats.load.map((l) => l.toFixed(1)).join(" / ")} ({stats.cpu.cores} cores)
              </div>
            </CardContent>
          </Card>

          {/* Disk */}
          <Card className="border-border">
            <CardHeader className="pb-2 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={diskLevel} /> Disk
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-2">
              <div className="text-2xl font-mono font-bold tabular-nums">{stats.disk.percent}%</div>
              <MiniBar value={stats.disk.percent} max={100} color={diskLevel === "critical" ? "bg-red-500" : diskLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              <div className="text-xs text-muted-foreground font-mono">
                {stats.disk.used} / {stats.disk.total}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Process Table */}
        <Card className="border-border">
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-mono text-muted-foreground">
              Top Processes by CPU
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <ScrollArea className="h-[440px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent border-border">
                    <TableHead className="font-mono text-xs w-16">PID</TableHead>
                    <TableHead className="font-mono text-xs">Process</TableHead>
                    <TableHead className="font-mono text-xs w-16">User</TableHead>
                    <TableHead className="font-mono text-xs w-20 text-right">CPU %</TableHead>
                    <TableHead className="font-mono text-xs w-20 text-right">MEM %</TableHead>
                    <TableHead className="font-mono text-xs w-20 text-right">RSS</TableHead>
                    <TableHead className="font-mono text-xs w-20 text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.processes.top.map((proc) => {
                    const cpuHot = proc.cpu > 50;
                    const cpuWarm = proc.cpu > 20;
                    const memHot = proc.mem > 5;
                    return (
                      <TableRow key={proc.pid} className="border-border hover:bg-muted/50 group">
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{proc.pid}</TableCell>
                        <TableCell className="font-mono text-xs truncate max-w-[300px]" title={proc.command}>
                          {proc.command}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{proc.user}</TableCell>
                        <TableCell className={`font-mono text-xs tabular-nums text-right ${cpuHot ? "text-red-400 font-bold" : cpuWarm ? "text-amber-400" : ""}`}>
                          {proc.cpu.toFixed(1)}
                        </TableCell>
                        <TableCell className={`font-mono text-xs tabular-nums text-right ${memHot ? "text-amber-400" : ""}`}>
                          {proc.mem.toFixed(1)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-right text-muted-foreground">
                          {formatBytes(proc.rss)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs font-mono opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-300 hover:bg-red-500/10"
                            onClick={() => handleKill(proc.pid, proc.command)}
                            disabled={killingPid === proc.pid}
                          >
                            {killingPid === proc.pid ? "..." : "kill"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
