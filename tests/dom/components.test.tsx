import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";

import { LedMeter } from "@/components/bench/led-meter";
import { ThemeControls } from "@/components/bench/theme-controls";
import { TrustLamp } from "@/components/bench/trust-lamp";
import { ProcessTable } from "@/components/dashboard/process-table";
import { currentRetro, currentTheme } from "@/lib/prefs";
import type { ProcessInfo } from "@/lib/schemas";

afterEach(() => {
  cleanup();
});

const proc = (over: Partial<ProcessInfo>): ProcessInfo => ({
  user: "rajan",
  pid: 1000,
  ppid: 1,
  cpu: 0,
  mem: 0,
  rss: 0,
  command: "x",
  path: "/usr/bin/x",
  elapsed: 0,
  trust: "apple",
  publisher: "Apple",
  bundleId: null,
  ...over,
});

const rows: ProcessInfo[] = [
  proc({ pid: 648, cpu: 72, command: "fileproviderd", path: "/System/x/fileproviderd" }),
  proc({
    pid: 900,
    cpu: 3,
    command: "Google Chrome",
    path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    trust: "developer-id",
    publisher: "Google LLC",
  }),
  proc({
    pid: 2000,
    cpu: 12,
    user: "root",
    command: "gh",
    path: "/opt/homebrew/bin/gh",
    trust: "adhoc",
    publisher: null,
  }),
];

describe("TrustLamp", () => {
  test("carries the state as data and the label as text", () => {
    render(<TrustLamp trust="unsigned" />);
    const lamp = screen.getByText("Not signed").closest(".lamp");
    expect(lamp?.getAttribute("data-state")).toBe("alarm");
    expect(screen.getByText("Unsigned")).toBeTruthy();
  });
});

describe("LedMeter", () => {
  test("exposes a meter with a spoken value and lights segments in steps", () => {
    render(<LedMeter value={55} max={100} warnAt={60} critAt={85} label="CPU meter" />);
    const meter = screen.getByRole("meter", { name: "CPU meter" });
    expect(meter.getAttribute("aria-valuenow")).toBe("55");
    expect(meter.getAttribute("aria-valuetext")).toBe("55% of scale, normal");
    // 55% of ten segments rounds to six lit; lit segments carry a glow.
    const lit = [...meter.querySelectorAll("span")].filter((s) => s.style.boxShadow !== "none");
    expect(lit).toHaveLength(6);
  });
});

describe("ThemeControls", () => {
  beforeEach(() => {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.retro = "1";
  });

  test("flips the html attributes on pointer-down and reflects them", async () => {
    render(<ThemeControls />);
    const theme = screen.getByRole("button", { name: "night shift" });
    fireEvent.pointerDown(theme);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(await screen.findByRole("button", { name: "daylight" })).toBeTruthy();

    const retro = screen.getByRole("button", { name: /Retro intensity: instrument/ });
    fireEvent.pointerDown(retro);
    expect(document.documentElement.dataset.retro).toBe("2");
    expect(await screen.findByRole("button", { name: /Retro intensity: tube/ })).toBeTruthy();
  });

  test("server render uses the defaults, and unmounting stops observing", () => {
    expect(renderToString(<ThemeControls />)).toContain("night shift");
    const { unmount } = render(<ThemeControls />);
    unmount();
    document.documentElement.dataset.theme = "light";
    expect(screen.queryByRole("button", { name: "daylight" })).toBeNull();
  });

  test("keyboard: Enter and Space activate the switches", async () => {
    render(<ThemeControls />);
    fireEvent.keyDown(screen.getByRole("button", { name: "night shift" }), { key: "Enter" });
    expect(document.documentElement.dataset.theme).toBe("light");
    fireEvent.keyDown(await screen.findByRole("button", { name: /Retro intensity/ }), { key: " " });
    expect(document.documentElement.dataset.retro).toBe("2");
  });
});

describe("prefs fallbacks", () => {
  test("reads stored values when the attributes are absent, and the OS preference last", () => {
    delete document.documentElement.dataset.theme;
    delete document.documentElement.dataset.retro;
    localStorage.setItem("sm:theme", "light");
    localStorage.setItem("sm:retro", "2");
    expect(currentTheme()).toBe("light");
    expect(currentRetro()).toBe("2");
    localStorage.removeItem("sm:theme");
    localStorage.removeItem("sm:retro");
    expect(currentRetro()).toBe("1");
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("light"),
    })) as unknown as typeof window.matchMedia;
    expect(currentTheme()).toBe("light");
    window.matchMedia = original;
  });
});

describe("ProcessTable", () => {
  const renderTable = (over: Partial<React.ComponentProps<typeof ProcessTable>> = {}) => {
    const calls = {
      select: [] as (number | null)[],
      inspect: [] as number[],
      kill: [] as number[],
    };
    render(
      <ProcessTable
        processes={rows}
        alerts={[{ pid: 648, command: "fileproviderd", cpu: 72, duration: 30 }]}
        currentUser="rajan"
        killingPid={null}
        selectedPid={null}
        onSelect={(pid) => calls.select.push(pid)}
        onInspect={(pid) => calls.inspect.push(pid)}
        onKill={(pid) => calls.kill.push(pid)}
        {...over}
      />,
    );
    return calls;
  };

  const bodyRows = () =>
    within(screen.getByRole("grid", { name: "Processes" }))
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.getAttribute("data-pid"));

  test("sorts by CPU descending by default and flips on heading click", () => {
    renderTable();
    expect(bodyRows()).toEqual(["648", "2000", "900"]);
    fireEvent.click(screen.getByRole("button", { name: /^CPU/ }));
    expect(bodyRows()).toEqual(["900", "2000", "648"]);
    // Case-insensitive: "gh" sorts before "Google Chrome".
    fireEvent.click(screen.getByRole("button", { name: /^Process/ }));
    expect(bodyRows()).toEqual(["648", "2000", "900"]);
  });

  test("filters and search narrow the rows and report the count", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "unsigned or ad-hoc" }));
    expect(bodyRows()).toEqual(["2000"]);
    fireEvent.click(screen.getByRole("button", { name: "all" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "google" } });
    expect(bodyRows()).toEqual(["900"]);
    expect(screen.getByRole("status").textContent).toBe("1 of 3 processes");
  });

  test("every kill control names the process and PID; the hot row is flagged in text", () => {
    renderTable();
    expect(screen.getByRole("button", { name: "Terminate fileproviderd, PID 648" })).toBeTruthy();
    expect(screen.getByText("flagged: sustained high CPU")).toBeTruthy();
  });

  test("pointer: click selects, double-click inspects, the kill button kills", () => {
    const calls = renderTable();
    const grid = screen.getByRole("grid", { name: "Processes" });
    const row = within(grid).getAllByRole("row")[1];
    if (!row) throw new Error("expected a body row");
    fireEvent.click(row);
    expect(calls.select).toEqual([648]);
    fireEvent.doubleClick(row);
    expect(calls.inspect).toEqual([648]);
    fireEvent.click(screen.getByRole("button", { name: "Terminate fileproviderd, PID 648" }));
    expect(calls.kill).toEqual([648]);
    // Inspecting via the name button does not also select through the row.
    fireEvent.click(screen.getByRole("button", { name: "Inspect Google Chrome, PID 900" }));
    expect(calls.inspect).toEqual([648, 900]);
    expect(calls.select).toEqual([648]);
  });

  test("keys with nothing selected: k picks the last row, Enter and x do nothing", () => {
    const calls = renderTable();
    const grid = screen.getByRole("grid", { name: "Processes" });
    fireEvent.keyDown(grid, { key: "Enter" });
    fireEvent.keyDown(grid, { key: "x" });
    expect(calls.inspect).toEqual([]);
    expect(calls.kill).toEqual([]);
    fireEvent.keyDown(grid, { key: "k" });
    expect(calls.select).toEqual([900]);
  });

  test("keyboard: j/k select, Enter inspects, x asks to kill, / focuses search", () => {
    const calls = renderTable({ selectedPid: 648 });
    const grid = screen.getByRole("grid", { name: "Processes" });
    fireEvent.keyDown(grid, { key: "j" });
    expect(calls.select).toEqual([2000]);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(calls.inspect).toEqual([648]);
    fireEvent.keyDown(grid, { key: "x" });
    expect(calls.kill).toEqual([648]);
    fireEvent.keyDown(grid, { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });
});
