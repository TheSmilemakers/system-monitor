/**
 * Shared fixtures for exercising production entry points (route handlers,
 * server actions, the sampler) against recorded macOS tool output.
 *
 * Installed through the seams in `@/lib/probe`, `@/lib/guard` and
 * `@/lib/identity`, so the real machine is never consulted and Bun's
 * process-wide module mocks are avoided.
 */

import { __setHeadersProvider } from "@/lib/guard";
import { __setCodesignRunner } from "@/lib/identity";
import { __setProbeImpl, type Probe } from "@/lib/probe";

export const TOP_OUTPUT = [
  "Processes: 612 total, 3 running, 609 sleeping, 3210 threads ",
  "2026/09/26 00:30:00",
  "Load Avg: 2.10, 2.35, 2.50 ",
  "CPU usage: 12.5% user, 7.5% sys, 80.0% idle ",
  "SharedLibs: 500M resident, 100M data, 50M linkedit.",
  "PhysMem: 15G used (1600M wired, 800M compressor), 1000M unused.",
].join("\n");

export const VM_STAT_OUTPUT = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                               50000.",
  "Pages active:                            200000.",
  "Pages inactive:                          100000.",
  "Pages speculative:                         1000.",
  "Pages throttled:                              0.",
  "Pages wired down:                        100000.",
  "Pages purgeable:                           2000.",
  "Pages occupied by compressor:             50000.",
].join("\n");

export const SWAP_OUTPUT =
  "vm.swapusage: total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)";

export const DF_OUTPUT = [
  "Filesystem        Size    Used   Avail Capacity iused      ifree %iused  Mounted on",
  "/dev/disk3s1s1   926Gi    12Gi   800Gi     2%  500000 8000000000    0%   /",
].join("\n");

/** `ps aux` column order: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND */
export const PS_OUTPUT = [
  "USER   PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND",
  "rajan  648  72.0  0.4 12345678  63488   ??  S    Mon07AM   1:23.45 /System/Library/PrivateFrameworks/FileProvider.framework/Support/fileproviderd",
  "rajan  900   3.0  1.4  1234567 227328   ??  S    Mon07AM   0:01.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "rajan  901   1.0  0.5  1234567  81920   ??  S    Mon07AM   0:01.00 /Applications/Safari.app/Contents/MacOS/Safari",
  "rajan  902   2.0  0.9  1234567 122880   ??  S    Mon07AM   0:01.00 /Applications/Slack.app/Contents/MacOS/Slack",
  "root   637  11.1  0.1  1234567  15360   ??  Ss   Mon07AM   0:10.00 /usr/sbin/filecoordinationd",
  "rajan  950   0.5  0.1  1234567  10240   ??  S    Mon07AM   0:00.10 /usr/libexec/trustd",
].join("\n");

/** `ps -axwwo user=,pid=,ppid=,%cpu=,%mem=,rss=,etime=,comm=`: the sampler's form. */
export const PS_DETAILED_OUTPUT = [
  "rajan    648     1  72.0  0.4  63488  18-00:12:06 /System/Library/PrivateFrameworks/FileProvider.framework/Support/fileproviderd",
  "rajan    900     1   3.0  1.4 227328     03:23:33 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "rajan    901     1   1.0  0.5  81920        05:12 /Applications/Safari.app/Contents/MacOS/Safari",
  "rajan    902     1   2.0  0.9 122880  12-05:04:40 /Applications/Slack.app/Contents/MacOS/Slack",
  "rajan    903   900   0.8  0.6  70000     01:00:00 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/140.0.0.0/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)",
  "root     637     1  11.1  0.1  15360  18-00:12:06 /usr/sbin/filecoordinationd",
  "rajan    950     1   0.5  0.1  10240  18-00:12:00 /usr/libexec/trustd",
  "root       0     0   0.0  0.0      0  18-00:12:10 kernel_task",
].join("\n");

export const PS_DETAILED_OUTPUT_IDLE = [
  "rajan    648     1   5.0  0.4  63488  18-00:12:06 /System/Library/PrivateFrameworks/FileProvider.framework/Support/fileproviderd",
  "root     637     1   1.1  0.1  15360  18-00:12:06 /usr/sbin/filecoordinationd",
].join("\n");

export const PS_OUTPUT_IDLE = [
  "USER   PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND",
  "rajan  648   5.0  0.4 12345678  63488   ??  S    Mon07AM   1:23.45 /System/Library/PrivateFrameworks/FileProvider.framework/Support/fileproviderd",
  "root   637   1.1  0.1  1234567  15360   ??  Ss   Mon07AM   0:10.00 /usr/sbin/filecoordinationd",
].join("\n");

export const PMSET_OUTPUT = [
  "Now drawing from 'AC Power'",
  " -InternalBattery-0 (id=1234)\t80%; charging; 0:45 remaining present: true",
].join("\n");

export const UPTIME_OUTPUT = " 0:30  up 18 days, 11 mins, 3 users, load averages: 2.10 2.35 2.50";

/** Column order: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (STATE) */
export const LSOF_OUTPUT = [
  "COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
  "Google      900 rajan   23u  IPv4 0x1               0t0  TCP 192.168.1.5:50000->10.0.0.9:443 (ESTABLISHED)",
  "Slack       902 rajan   24u  IPv4 0x2               0t0  TCP 192.168.1.5:50001->999.999.1.1:443 (ESTABLISHED)",
  "rapportd    300 rajan   10u  IPv4 0x3               0t0  TCP *:49152 (LISTEN)",
].join("\n");

/** `lsof -a -d txt -Fpn -p 95665,54357`: the executable is the first text file per pid. */
export const LSOF_TXT_OUTPUT = [
  "p95665",
  "n/Users/rajan/.nvm/versions/node/v22.17.0/bin/node",
  "n/usr/lib/dyld",
  "p54357",
  "n/Applications/Claude.app/Contents/MacOS/Claude",
  "n/usr/lib/dyld",
].join("\n");

export const USER_AGENTS_OUTPUT = "com.example.updater.plist\ncom.google.keystone.agent.plist";
export const SYS_AGENTS_OUTPUT =
  "com.apple.foo.plist\ncom.docker.vmnetd.plist\ncom.acme.helper.plist";
export const DAEMONS_OUTPUT = "com.apple.bar.plist";

/** Recorded `codesign -dv --verbose=2` output for each trust case. */
export const CODESIGN_APPLE = [
  "Executable=/usr/sbin/filecoordinationd",
  "Identifier=com.apple.filecoordinationd",
  "Format=Mach-O universal (x86_64 arm64e)",
  "Authority=Software Signing",
  "Authority=Apple Code Signing Certification Authority",
  "Authority=Apple Root CA",
  "TeamIdentifier=not set",
].join("\n");

export const CODESIGN_DEVELOPER_ID = [
  "Identifier=com.google.Chrome",
  "Format=app bundle with Mach-O universal (x86_64 arm64)",
  "Authority=Developer ID Application: Google LLC (EQHXZ8M8AV)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "TeamIdentifier=EQHXZ8M8AV",
].join("\n");

export const CODESIGN_APP_STORE = [
  "Identifier=com.example.storeapp",
  "Authority=Apple Mac OS Application Signing",
  "Authority=Apple Worldwide Developer Relations Certification Authority",
  "Authority=Apple Root CA",
  "TeamIdentifier=ABCDE12345",
].join("\n");

export const CODESIGN_ADHOC = [
  "Identifier=a.out",
  "Signature=adhoc",
  "TeamIdentifier=not set",
].join("\n");

export const CODESIGN_UNSIGNED = "/Users/rajan/Desktop/launch: code object is not signed at all";

export const FIREWALL_OFF = "Firewall is disabled. (State = 0)\nFirewall stealth mode is on";
export const FIREWALL_ON = "Firewall is enabled. (State = 1)\nFirewall stealth mode is off";
export const SIP_ON = "System Integrity Protection status: enabled.";
export const GATEKEEPER_ON = "assessments enabled";
export const FILEVAULT_ON = "FileVault is On.";
export const NETSTAT_OUTPUT = [
  "Active Internet connections (including servers)",
  "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
  "tcp4       0      0  127.0.0.1.3000         *.*                    LISTEN",
  "tcp6       0      0  *.39503                *.*                    LISTEN",
  "tcp4       0      0  *.22                   *.*                    LISTEN",
  "tcp4       0      0  192.168.1.5.50000      10.0.0.9.443           ESTABLISHED",
].join("\n");
export const NETSTAT_IB_OUTPUT = [
  "Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll",
  "lo0        16384 <Link#1>                       7656716     0 1491730691  7656716     0 1491730691     0",
  "gif0*      1280  <Link#2>                             0     0          0        0     0          0     0",
  "en0        1500  <Link#11>   a4:83:e7:00:00:01  1000000     0 2000000000   500000     0  500000000     0",
  "en0        1500  192.168.1     192.168.1.5      1000000     - 2000000000   500000     -  500000000     -",
  "utun4      1400  <Link#30>                        10000     0   10000000     5000     0    5000000     0",
].join("\n");

export const SYSEXT_OUTPUT = [
  "1 extension(s)",
  "--- com.apple.system_extension.endpoint_security",
  "enabled\tactive\tteamID\tbundleID (version)\tname\t[state]",
  "*\t*\tW5W395V82Y\tcom.nordvpn.macos.Shield (10.8.1/371)\tNordVPN protection\t[activated enabled]",
].join("\n");
export const SOFTWAREUPDATE_OUTPUT = [
  "Software Update Tool",
  "",
  "Software Update found the following new or updated software:",
  "* Label: Safari27.0TahoeAuto-27.0",
  "\tTitle: Safari, Version: 27.0, Size: 249465KiB, Recommended: YES, ",
].join("\n");

/** `man -P cat fileproviderd`, with the overstrike bold that man emits for terminals. */
export const MAN_FILEPROVIDERD = [
  "FILEPROVIDERD(8)            System Manager's Manual           FILEPROVIDERD(8)",
  "",
  "N\bNA\bAM\bME\bE",
  "     f\bfi\bil\ble\bep\bpr\bro\bov\bvi\bid\bde\ber\brd\bd \u2013 Part of File Coordination",
  "",
  "S\bSY\bYN\bNO\bOP\bPS\bSI\bIS\bS",
  "     f\bfi\bil\ble\bep\bpr\bro\bov\bvi\bid\bde\ber\brd\bd",
  "",
  "D\bDE\bES\bSC\bCR\bRI\bIP\bPT\bTI\bIO\bON\bN",
  "     f\bfi\bil\ble\bep\bpr\bro\bov\bvi\bid\bde\ber\brd\bd is the daemon controlling the interaction between",
  "     extensions and filecoordinationd. It is also responsible for coordinating",
  "     enumeration and property lookup.",
  "",
  "     There are no configuration options to fileproviderd, and users should not",
  "     run fileproviderd manually.",
  "",
  "macOS                              11/07/17                              macOS",
].join("\n");

export const TOP_PID_OUTPUT = [
  "Processes: 612 total, 3 running, 609 sleeping, 3210 threads ",
  "",
  "PID  #TH  POWER %CPU MEM  ",
  "648  11/6 4.1   72.0 197M ",
].join("\n");

/** `lsof -a -nP -i -p 648` */
export const LSOF_PID_OUTPUT = [
  "COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
  "fileprovi   648 rajan   23u  IPv4 0x1               0t0  TCP 192.168.1.5:50000->10.0.0.9:443 (ESTABLISHED)",
  "fileprovi   648 rajan   24u  IPv6 0x2               0t0  TCP [::1]:50001->[::1]:8080 (CLOSE_WAIT)",
  "fileprovi   648 rajan   25u  IPv4 0x3               0t0  UDP *:5353",
].join("\n");

/** `lsof -p 648`: header plus open files. */
export const LSOF_FILES_OUTPUT = [
  "COMMAND   PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
  "fileprovi 648 rajan  cwd    DIR   1,13      640    2 /",
  "fileprovi 648 rajan  txt    REG   1,13   123456  100 /System/x/fileproviderd",
  "fileprovi 648 rajan    0r   CHR    3,2      0t0  333 /dev/null",
].join("\n");

const ok = (value: string): Probe<string> => ({ status: "ok", value });

/** Per-command fixture responses; override any of them per test. */
export type ProbeOverrides = Partial<Record<string, (args: readonly string[]) => Probe<string>>>;

export function fakeProbe(overrides: ProbeOverrides = {}) {
  return async (file: string, args: readonly string[]): Promise<Probe<string>> => {
    const custom = overrides[file];
    if (custom) return custom(args);
    switch (file) {
      case "top":
        if (args.includes("-pid")) return ok(TOP_PID_OUTPUT);
        return ok(TOP_OUTPUT);
      case "vm_stat":
        return ok(VM_STAT_OUTPUT);
      case "sysctl": {
        const key = args[args.length - 1];
        if (key === "vm.swapusage") return ok(SWAP_OUTPUT);
        if (key === "hw.memsize") return ok("17179869184");
        if (key === "hw.ncpu") return ok("10");
        if (key === "machdep.cpu.brand_string") return ok("Apple M1 Pro");
        if (key === "hw.pagesize") return ok("16384");
        return { status: "failed", error: `unexpected sysctl ${key}` };
      }
      case "df":
        return ok(DF_OUTPUT);
      case "ps":
        // `ps -o user=,lstart= -p <pid>` is process identity; `-axwwo` is the
        // sampler's detailed list; `ps aux` is what the scans read.
        if (args[0] === "-o" && args[1] === "stat=,nice=,ppid=") return ok("S     0     1");
        if (args[0] === "-o" && args[1] === "comm=")
          return ok("/Applications/Slack.app/Contents/MacOS/Slack");
        if (args[0] === "-o" && args[1] === "stat=") return ok("S");
        if (args[0] === "-o") return ok("rajan Mon Sep 22 07:00:00 2026");
        if (args[0] === "-axwwo") return ok(PS_DETAILED_OUTPUT);
        return ok(PS_OUTPUT);
      case "pmset":
        return ok(PMSET_OUTPUT);
      case "uptime":
        return ok(UPTIME_OUTPUT);
      case "whoami":
        return ok("rajan");
      case "lsof":
        if (args[0] === "-a" && args.includes("-i")) return ok(LSOF_PID_OUTPUT);
        if (args[0] === "-a") return ok(LSOF_TXT_OUTPUT);
        if (args[0] === "-p") return ok(LSOF_FILES_OUTPUT);
        return ok(LSOF_OUTPUT);
      case "ls": {
        const target = args[0] ?? "";
        if (target.endsWith("/.ssh"))
          return ok("authorized_keys\nid_ed25519\nid_ed25519.pub\nknown_hosts");
        if (target.endsWith("/Library/LaunchAgents") && !target.startsWith("/Library"))
          return ok(USER_AGENTS_OUTPUT);
        if (target === "/Library/LaunchAgents") return ok(SYS_AGENTS_OUTPUT);
        if (target === "/Library/LaunchDaemons") return ok(DAEMONS_OUTPUT);
        return ok("");
      }
      case "sqlite3":
        return { status: "denied" };
      case "du":
        return ok(`40960\t${args[1] ?? ""}`);
      case "find":
        return ok("a\nb\nc");
      case "spctl":
        if (args[0] === "--assess") {
          return ok(
            `${args[args.length - 1]}: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Slack Technologies, LLC (BQR82RBBHL)`,
          );
        }
        return ok(GATEKEEPER_ON);
      case "xattr":
        return { status: "failed", error: "No such xattr: com.apple.quarantine" };
      case "open":
        return ok("");
      case "renice":
        return ok("");
      case "sample":
        return ok(
          [
            "Sampling process 648 for 2 seconds with 1 millisecond of run time between samples",
            "Call graph:",
            "    2001 Thread_1  DispatchQueue_1: com.apple.main-thread  (serial)",
            "    + 2001 start  (in dyld) + 1234  [0x1000]",
          ].join("\n"),
        );
      case "shasum":
        // One line per file argument: a stable fake hash derived from the path.
        return ok(
          args
            .slice(2)
            .map(
              (p) => `${"0".repeat(60)}${(p.length % 10000).toString(16).padStart(4, "0")}  ${p}`,
            )
            .join("\n"),
        );
      case "osascript":
        return ok("");
      case "dscl":
        if (args[1] === "-list") return ok("_mbsetupuser\ndaemon\nnobody\nrajan\nroot");
        return ok("GroupMembership: root rajan");
      case "scutil":
        return ok(
          [
            "DNS configuration",
            "resolver #1",
            "  nameserver[0] : 1.1.1.1",
            "  nameserver[1] : 8.8.8.8",
            "resolver #2",
            "  nameserver[0] : 1.1.1.1",
          ].join("\n"),
        );
      case "man":
        // `man -w name` says whether a page exists; `man -P cat name` prints it.
        if (args[0] === "-w") {
          return args[1] === "fileproviderd"
            ? ok("/usr/share/man/man8/fileproviderd.8")
            : { status: "failed", error: `No manual entry for ${args[1]}` };
        }
        return ok(MAN_FILEPROVIDERD);
      case "/usr/libexec/ApplicationFirewall/socketfilterfw":
        return ok(FIREWALL_OFF);
      case "csrutil":
        return ok(SIP_ON);
      case "fdesetup":
        return ok(FILEVAULT_ON);
      case "plutil": {
        const file = args[args.length - 1] ?? "";
        if (!file.endsWith(".plist") || file.includes("XProtect")) return ok("5360");
        if (file.includes("com.acme.helper"))
          return ok(
            JSON.stringify({
              Label: "com.acme.helper",
              ProgramArguments: ["/Users/rajan/Downloads/acme-helper", "--daemon"],
              RunAtLoad: true,
              KeepAlive: { SuccessfulExit: false },
            }),
          );
        if (file.includes("com.docker.vmnetd"))
          return ok(
            JSON.stringify({
              Label: "com.docker.vmnetd",
              Program: "/Library/PrivilegedHelperTools/com.docker.vmnetd",
              RunAtLoad: true,
            }),
          );
        if (file.includes("com.example.updater")) {
          // Dates cannot be expressed as JSON: plutil fails and the XML fallback runs.
          if (args[1] === "json")
            return { status: "failed", error: "invalid object in plist for destination format" };
          return ok(
            [
              '<?xml version="1.0" encoding="UTF-8"?>',
              '<plist version="1.0"><dict>',
              "<key>Label</key><string>com.example.updater</string>",
              "<key>ProgramArguments</key><array><string>/Applications/Example.app/Contents/MacOS/updater</string></array>",
              "<key>RunAtLoad</key><true/>",
              "<key>KeepAlive</key><true/>",
              "</dict></plist>",
            ].join("\n"),
          );
        }
        return ok(
          JSON.stringify({
            Label:
              file
                .split("/")
                .pop()
                ?.replace(/\.plist$/, "") ?? "",
          }),
        );
      }
      case "profiles":
        return ok("There are no configuration profiles installed for user 'rajan'");
      case "stat":
        // XProtect plist modified 10 days before the fixed test clock (2026-09-26T00:30:00Z).
        return ok(String(Math.floor(Date.parse("2026-09-16T00:30:00Z") / 1000)));
      case "netstat":
        if (args[0] === "-ibn") return ok(NETSTAT_IB_OUTPUT);
        return ok(NETSTAT_OUTPUT);
      case "systemextensionsctl":
        return ok(SYSEXT_OUTPUT);
      case "softwareupdate":
        return ok(SOFTWAREUPDATE_OUTPUT);
      default:
        return { status: "unsupported" };
    }
  };
}

export function installFakeProbe(overrides: ProbeOverrides = {}): void {
  __setProbeImpl(fakeProbe(overrides));
}

/** Codesign by path prefix: Apple for /System and /usr, Developer ID for /Applications. */
export function fakeCodesign(overrides: Record<string, { ok: boolean; output: string }> = {}) {
  return async (path: string): Promise<{ ok: boolean; output: string }> => {
    const custom = overrides[path];
    if (custom) return custom;
    if (path.startsWith("/System") || path.startsWith("/usr") || path.startsWith("/sbin")) {
      return { ok: true, output: CODESIGN_APPLE };
    }
    if (path.startsWith("/Applications")) return { ok: true, output: CODESIGN_DEVELOPER_ID };
    if (path.startsWith("/opt/homebrew")) return { ok: true, output: CODESIGN_ADHOC };
    return { ok: false, output: CODESIGN_UNSIGNED };
  };
}

export function installFakeCodesign(
  overrides: Record<string, { ok: boolean; output: string }> = {},
): void {
  __setCodesignRunner(fakeCodesign(overrides));
}

export function installHeaders(values: Record<string, string | undefined>): void {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(values)) if (v !== undefined) map.set(k.toLowerCase(), v);
  __setHeadersProvider(async () => ({
    get: (name: string) => map.get(name.toLowerCase()) ?? null,
  }));
}

export function installLoopbackHeaders(): void {
  installHeaders({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" });
}

export function resetSeams(): void {
  __setProbeImpl(null);
  __setHeadersProvider(null);
  __setCodesignRunner(null);
}
