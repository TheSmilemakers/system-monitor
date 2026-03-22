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

// --- Types ---

interface HistoryPoint {
  ts: number;
  cpu: number;
  mem: number;
  swap: number;
  load: number;
}

interface ScanFinding {
  severity: "critical" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  processes: { pid: number; name: string; cpu: number; mem: number; rss: number }[];
  recommendation: string;
}

interface ScanResult {
  healthScore: number;
  findings: ScanFinding[];
  summary: {
    totalProcesses: number;
    electronApps: number;
    electronProcesses: number;
    browsers: number;
    launchItems: number;
    swapUsedMB: number;
  };
  timestamp: number;
}

interface ProcessAlert {
  pid: number;
  command: string;
  cpu: number;
  duration: number;
}

interface SystemStats {
  cpu: { user: number; system: number; idle: number; used: number; model: string; cores: number };
  load: number[];
  memory: { totalGB: number; usedGB: number; freeGB: number; percent: number; wiredGB: number; compressorGB: number };
  swap: { totalMB: number; usedMB: number; percent: number };
  disk: { total: string; used: string; available: string; percent: number };
  processes: { total: number; threads: number; top: ProcessInfo[] };
  uptime: string;
  battery: { percent: number; charging: boolean } | null;
  history: HistoryPoint[];
  alerts: ProcessAlert[];
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

// --- Utilities ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m${sec > 0 ? ` ${sec}s` : ""}`;
}

// --- Components ---

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

function Sparkline({
  data,
  max,
  color,
  warnAt,
  critAt,
  width = 200,
  height = 40,
}: {
  data: number[];
  max: number;
  color: string;
  warnAt?: number;
  critAt?: number;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center text-xs text-muted-foreground font-mono">
        collecting...
      </div>
    );
  }

  const padding = 2;
  const h = height - padding * 2;
  const w = width - padding * 2;
  const step = w / (data.length - 1);
  const clampMax = Math.max(max, Math.max(...data) * 1.1) || 1;

  const points = data.map((v, i) => {
    const x = padding + i * step;
    const y = padding + h - (Math.min(v, clampMax) / clampMax) * h;
    return `${x},${y}`;
  }).join(" ");

  // Gradient fill area
  const areaPoints = `${padding},${padding + h} ${points} ${padding + (data.length - 1) * step},${padding + h}`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      {/* Threshold lines */}
      {warnAt !== undefined && (
        <line
          x1={padding} y1={padding + h - (warnAt / clampMax) * h}
          x2={padding + w} y2={padding + h - (warnAt / clampMax) * h}
          stroke="oklch(0.828 0.189 84.429)" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.4"
        />
      )}
      {critAt !== undefined && (
        <line
          x1={padding} y1={padding + h - (critAt / clampMax) * h}
          x2={padding + w} y2={padding + h - (critAt / clampMax) * h}
          stroke="oklch(0.704 0.191 22.216)" strokeWidth="0.5" strokeDasharray="3,3" opacity="0.4"
        />
      )}
      {/* Fill */}
      <polygon points={areaPoints} fill={color} opacity="0.1" />
      {/* Line */}
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Current value dot */}
      {data.length > 0 && (
        <circle
          cx={padding + (data.length - 1) * step}
          cy={padding + h - (Math.min(data[data.length - 1], clampMax) / clampMax) * h}
          r="2.5" fill={color}
        />
      )}
    </svg>
  );
}

// --- Main Dashboard ---

export default function Dashboard() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState(3000);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [killMessage, setKillMessage] = useState<{ pid: number; success: boolean; error?: string } | null>(null);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [, startTransition] = useTransition();

  const runScan = useCallback(async () => {
    setScanning(true);
    setShowScan(true);
    try {
      const res = await fetch("/api/scan", { cache: "no-store" });
      if (!res.ok) throw new Error("Scan failed");
      const data = await res.json();
      setScanResult(data);
    } catch {
      setScanResult(null);
    } finally {
      setScanning(false);
    }
  }, []);

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

  const cpuHistory = stats.history?.map((h) => h.cpu) || [];
  const memHistory = stats.history?.map((h) => h.mem) || [];
  const swapHistory = stats.history?.map((h) => h.swap) || [];
  const loadHistory = stats.history?.map((h) => h.load) || [];

  const sparkColor = (level: "ok" | "warn" | "critical") =>
    level === "critical" ? "oklch(0.704 0.191 22.216)" : level === "warn" ? "oklch(0.828 0.189 84.429)" : "oklch(0.765 0.177 163.223)";

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
            variant="outline"
            size="sm"
            className="h-6 px-3 text-xs font-mono"
            onClick={runScan}
            disabled={scanning}
          >
            {scanning ? "Scanning..." : "Scan System"}
          </Button>
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

      {/* Process Alerts */}
      {stats.alerts && stats.alerts.length > 0 && (
        <div className="mx-6 mt-3 space-y-2">
          {stats.alerts.map((alert) => (
            <div
              key={alert.pid}
              className="flex items-center justify-between px-3 py-2 rounded bg-red-500/10 border border-red-500/20 text-xs font-mono"
            >
              <div className="flex items-center gap-3">
                <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <span className="text-red-400">
                  <span className="font-bold">{alert.command}</span> (PID {alert.pid}) stuck at {alert.cpu.toFixed(0)}% CPU for {formatDuration(alert.duration)}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs font-mono text-red-400 hover:text-red-300 hover:bg-red-500/20"
                onClick={() => handleKill(alert.pid, alert.command)}
                disabled={killingPid === alert.pid}
              >
                {killingPid === alert.pid ? "..." : "kill"}
              </Button>
            </div>
          ))}
        </div>
      )}

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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* CPU */}
          <Card className="border-border">
            <CardHeader className="pb-1 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={cpuLevel} /> CPU
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-1">
              <div className="flex items-end justify-between">
                <div className="text-2xl font-mono font-bold tabular-nums">{stats.cpu.used.toFixed(1)}%</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {stats.cpu.user.toFixed(0)}% usr / {stats.cpu.system.toFixed(0)}% sys
                </div>
              </div>
              <MiniBar value={stats.cpu.used} max={100} color={cpuLevel === "critical" ? "bg-red-500" : cpuLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              <Sparkline data={cpuHistory} max={100} color={sparkColor(cpuLevel)} warnAt={60} critAt={85} width={280} height={48} />
            </CardContent>
          </Card>

          {/* Memory */}
          <Card className="border-border">
            <CardHeader className="pb-1 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={memLevel} /> Memory
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-1">
              <div className="flex items-end justify-between">
                <div className="text-2xl font-mono font-bold tabular-nums">{stats.memory.usedGB}G <span className="text-sm text-muted-foreground">/ {stats.memory.totalGB}G</span></div>
                <div className="text-xs text-muted-foreground font-mono">
                  {stats.memory.wiredGB}G wired / {stats.memory.compressorGB}G comp
                </div>
              </div>
              <MiniBar value={stats.memory.usedGB} max={stats.memory.totalGB} color={memLevel === "critical" ? "bg-red-500" : memLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              <Sparkline data={memHistory} max={100} color={sparkColor(memLevel)} warnAt={70} critAt={90} width={280} height={48} />
            </CardContent>
          </Card>

          {/* Swap */}
          <Card className="border-border">
            <CardHeader className="pb-1 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={swapLevel} /> Swap
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-1">
              <div className="flex items-end justify-between">
                <div className="text-2xl font-mono font-bold tabular-nums">
                  {stats.swap.usedMB < 1024 ? `${stats.swap.usedMB}M` : `${(stats.swap.usedMB / 1024).toFixed(1)}G`}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {stats.swap.totalMB > 0 ? `${stats.swap.totalMB}M total` : "None allocated"}
                </div>
              </div>
              {stats.swap.totalMB > 0 ? (
                <MiniBar value={stats.swap.usedMB} max={stats.swap.totalMB} color={swapLevel === "critical" ? "bg-red-500" : swapLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              ) : (
                <div className="h-2 w-full rounded-full bg-muted" />
              )}
              <Sparkline data={swapHistory} max={Math.max(4096, ...swapHistory)} color={sparkColor(swapLevel)} warnAt={100} critAt={2000} width={280} height={48} />
            </CardContent>
          </Card>

          {/* Load */}
          <Card className="border-border">
            <CardHeader className="pb-1 pt-3 px-4">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                <StatusDot level={loadLevel} /> Load
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 space-y-1">
              <div className="flex items-end justify-between">
                <div className="text-2xl font-mono font-bold tabular-nums">{stats.load[0].toFixed(1)}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {stats.load.map((l) => l.toFixed(1)).join(" / ")} ({stats.cpu.cores} cores)
                </div>
              </div>
              <MiniBar value={stats.load[0]} max={stats.cpu.cores * 2} color={loadLevel === "critical" ? "bg-red-500" : loadLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              <Sparkline data={loadHistory} max={stats.cpu.cores * 2} color={sparkColor(loadLevel)} warnAt={stats.cpu.cores * 0.8} critAt={stats.cpu.cores * 1.2} width={280} height={48} />
            </CardContent>
          </Card>
        </div>

        {/* Disk (small) */}
        <div className="grid grid-cols-4 gap-3">
          <Card className="border-border col-span-1">
            <CardContent className="px-4 py-3 flex items-center gap-4">
              <div>
                <div className="text-xs font-mono text-muted-foreground flex items-center gap-2 mb-1">
                  <StatusDot level={diskLevel} /> Disk
                </div>
                <div className="text-lg font-mono font-bold tabular-nums">{stats.disk.percent}%</div>
                <div className="text-xs text-muted-foreground font-mono">{stats.disk.used} / {stats.disk.total}</div>
              </div>
              <div className="flex-1">
                <MiniBar value={stats.disk.percent} max={100} color={diskLevel === "critical" ? "bg-red-500" : diskLevel === "warn" ? "bg-amber-500" : "bg-emerald-500"} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Scan Results */}
        {showScan && (
          <Card className="border-border">
            <CardHeader className="pb-2 pt-3 px-4 flex flex-row items-center justify-between">
              <CardTitle className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                System Scan
                {scanResult && (
                  <Badge
                    variant="outline"
                    className={`font-mono text-xs ${
                      scanResult.healthScore >= 80
                        ? "border-emerald-500/30 text-emerald-400"
                        : scanResult.healthScore >= 50
                        ? "border-amber-500/30 text-amber-400"
                        : "border-red-500/30 text-red-400"
                    }`}
                  >
                    Health: {scanResult.healthScore}/100
                  </Badge>
                )}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs font-mono text-muted-foreground" onClick={runScan} disabled={scanning}>
                  {scanning ? "..." : "Re-scan"}
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs font-mono text-muted-foreground" onClick={() => setShowScan(false)}>
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {scanning && !scanResult ? (
                <div className="py-8 text-center text-sm text-muted-foreground font-mono animate-pulse">
                  Analyzing processes, launch agents, and resource usage...
                </div>
              ) : scanResult ? (
                <div className="space-y-3">
                  {/* Summary chips */}
                  <div className="flex flex-wrap gap-2 pb-2 border-b border-border">
                    <Badge variant="outline" className="font-mono text-xs">{scanResult.summary.totalProcesses} processes</Badge>
                    <Badge variant="outline" className="font-mono text-xs">{scanResult.summary.electronApps} Electron apps ({scanResult.summary.electronProcesses} procs)</Badge>
                    <Badge variant="outline" className="font-mono text-xs">{scanResult.summary.browsers} browser{scanResult.summary.browsers !== 1 ? "s" : ""}</Badge>
                    <Badge variant="outline" className="font-mono text-xs">{scanResult.summary.launchItems} startup items</Badge>
                    <Badge variant="outline" className={`font-mono text-xs ${scanResult.summary.swapUsedMB > 100 ? "border-amber-500/30 text-amber-400" : ""}`}>
                      {scanResult.summary.swapUsedMB}MB swap
                    </Badge>
                  </div>

                  {/* Findings */}
                  {scanResult.findings.length === 0 ? (
                    <div className="py-4 text-center text-sm text-emerald-400 font-mono">
                      System looks clean. No issues found.
                    </div>
                  ) : (
                    <ScrollArea className="max-h-[400px]">
                      <div className="space-y-2">
                        {scanResult.findings.map((finding, i) => (
                          <div
                            key={i}
                            className={`rounded border px-3 py-2.5 space-y-1.5 ${
                              finding.severity === "critical"
                                ? "bg-red-500/5 border-red-500/20"
                                : finding.severity === "warning"
                                ? "bg-amber-500/5 border-amber-500/20"
                                : "bg-muted/30 border-border"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                  finding.severity === "critical" ? "bg-red-500" :
                                  finding.severity === "warning" ? "bg-amber-500" : "bg-muted-foreground"
                                }`} />
                                <span className="text-xs font-mono font-medium">{finding.title}</span>
                                <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">{finding.category}</Badge>
                              </div>
                              {finding.processes.length > 0 && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-5 px-2 text-[10px] font-mono text-red-400 hover:text-red-300 hover:bg-red-500/10 flex-shrink-0"
                                  onClick={() => {
                                    const proc = finding.processes[0];
                                    handleKill(proc.pid, proc.name);
                                  }}
                                >
                                  kill main
                                </Button>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground font-mono leading-relaxed pl-3.5">{finding.detail}</p>
                            <p className="text-xs font-mono pl-3.5">
                              <span className="text-emerald-400/80">Recommendation:</span>{" "}
                              <span className="text-muted-foreground">{finding.recommendation}</span>
                            </p>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>
        )}

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
                    const isAlerted = stats.alerts?.some((a) => a.pid === proc.pid);
                    return (
                      <TableRow key={proc.pid} className={`border-border hover:bg-muted/50 group ${isAlerted ? "bg-red-500/5" : ""}`}>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{proc.pid}</TableCell>
                        <TableCell className="font-mono text-xs truncate max-w-[300px]" title={proc.command}>
                          {isAlerted && <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-2 animate-pulse" />}
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
                            className={`h-6 px-2 text-xs font-mono transition-opacity text-red-400 hover:text-red-300 hover:bg-red-500/10 ${isAlerted ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
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
