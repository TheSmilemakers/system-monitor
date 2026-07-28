"use client";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes } from "@/lib/format";
import type { ProcessAlert, ProcessInfo } from "@/lib/schemas";

export interface ProcessTableProps {
  processes: ProcessInfo[];
  alerts: ProcessAlert[];
  killingPid: number | null;
  onKill: (pid: number, name: string) => void;
}

export function ProcessTable({ processes, alerts, killingPid, onKill }: ProcessTableProps) {
  const alerted = new Set(alerts.map((a) => a.pid));

  return (
    <ScrollArea className="h-[440px]">
      <Table>
        {/* L-04: the table announces its own purpose. */}
        <TableCaption className="sr-only">
          Running processes ordered by CPU usage. Each row offers a button to terminate that process.
        </TableCaption>
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead scope="col" className="w-16 font-mono text-xs">PID</TableHead>
            <TableHead scope="col" className="font-mono text-xs">Process</TableHead>
            <TableHead scope="col" className="w-16 font-mono text-xs">User</TableHead>
            <TableHead scope="col" className="w-24 text-right font-mono text-xs">
              CPU<span className="sr-only"> percent of one core</span>
            </TableHead>
            <TableHead scope="col" className="w-20 text-right font-mono text-xs">MEM %</TableHead>
            <TableHead scope="col" className="w-20 text-right font-mono text-xs">RSS</TableHead>
            <TableHead scope="col" className="w-20 text-right font-mono text-xs">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {processes.map((proc) => {
            const isAlerted = alerted.has(proc.pid);
            const hot = proc.cpu > 50;
            const warm = proc.cpu > 20;
            const busy = killingPid === proc.pid;
            return (
              <TableRow
                key={proc.pid}
                className={`group border-border hover:bg-muted/50 ${isAlerted ? "bg-red-500/5" : ""}`}
              >
                <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                  {proc.pid}
                </TableCell>
                <TableCell className="max-w-[300px] truncate font-mono text-xs" title={proc.command}>
                  {isAlerted && (
                    <span
                      aria-hidden="true"
                      className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-red-500 motion-safe:animate-pulse"
                    />
                  )}
                  {proc.command}
                  {isAlerted && <span className="sr-only"> (flagged: sustained high CPU)</span>}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{proc.user}</TableCell>
                <TableCell
                  className={`text-right font-mono text-xs tabular-nums ${hot ? "font-bold text-red-400" : warm ? "text-amber-400" : ""}`}
                >
                  {proc.cpu.toFixed(1)}
                </TableCell>
                <TableCell
                  className={`text-right font-mono text-xs tabular-nums ${proc.mem > 5 ? "text-amber-400" : ""}`}
                >
                  {proc.mem.toFixed(1)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {formatBytes(proc.rss)}
                </TableCell>
                <TableCell className="text-right">
                  {/*
                    M-07: previously `opacity-0 group-hover:opacity-100`, which left
                    keyboard users tabbing to an invisible destructive control and
                    made it unreachable on touch. Now revealed by focus too, and
                    always visible on coarse pointers.
                  */}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Terminate ${proc.command}, PID ${proc.pid}`}
                    className={`h-6 min-h-6 px-2 font-mono text-xs text-red-400 transition-opacity hover:bg-red-500/10 hover:text-red-300 focus-visible:opacity-100 group-focus-within:opacity-100 ${
                      isAlerted ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    }`}
                    onClick={() => onKill(proc.pid, proc.command)}
                    disabled={busy}
                  >
                    {busy ? "…" : "kill"}
                    <span className="sr-only"> {proc.command}</span>
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}
