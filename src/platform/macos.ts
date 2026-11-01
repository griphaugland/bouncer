import { readdirSync, statSync } from "node:fs";
import type { LoadSample, Platform, Proc } from "./types";

// LC_ALL=C: sysctl and ps format decimals with the user's locale (Eirik's prints "10857,00M").
const C_ENV = { ...process.env, LC_ALL: "C" };

function run(cmd: string[]): string {
  const res = Bun.spawnSync(cmd, { env: C_ENV, stdout: "pipe", stderr: "ignore" });
  if (res.exitCode !== 0) throw new Error(`${cmd[0]} exited ${res.exitCode}`);
  return res.stdout.toString();
}

function parseMb(text: string, key: string): number {
  const m = text.match(new RegExp(`${key} = ([0-9.]+)([KMG])`));
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === "G" ? n * 1024 : m[2] === "K" ? n / 1024 : n;
}

/** ps time/etime: `[[dd-]hh:]mm:ss[.cc]`. Minutes may exceed 59 in `time`. */
export function parseDuration(s: string): number {
  const [days, rest] = s.includes("-") ? [Number(s.split("-")[0]), s.split("-")[1]!] : [0, s];
  const parts = rest.split(":").map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + (Number.isFinite(p) ? p : 0);
  return days * 86_400 + sec;
}

const DIAG_DIR = "/Library/Logs/DiagnosticReports";

export const macos: Platform = {
  sampleLoad(): LoadSample {
    const out = run([
      "/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level", "kern.memorystatus_level", "vm.swapusage",
    ]).split("\n");
    return {
      pressureLevel: Number(out[0]) || 1,
      freePercent: Number(out[1]) || 0,
      swapUsedMb: parseMb(out[2] ?? "", "used"),
      swapTotalMb: parseMb(out[2] ?? "", "total"),
    };
  },

  listProcesses(): Proc[] {
    const procs: Proc[] = [];
    for (const line of run(["/bin/ps", "-axo", "pid=,ppid=,rss=,time=,etime=,command="]).split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      procs.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        rssKb: Number(m[3]),
        cpuSec: parseDuration(m[4]!),
        elapsedSec: parseDuration(m[5]!),
        command: m[6]!,
      });
    }
    return procs;
  },

  cwdOf(pids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (!pids.length) return out;
    const res = Bun.spawnSync(["/usr/sbin/lsof", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], {
      env: C_ENV,
      stdout: "pipe",
      stderr: "ignore",
    });
    let pid = 0;
    for (const line of res.stdout.toString().split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
    }
    return out;
  },

  oomEventsSince(sinceMs: number): number {
    try {
      return readdirSync(DIAG_DIR).filter((f) => {
        if (!f.startsWith("JetsamEvent-")) return false;
        try {
          return statSync(`${DIAG_DIR}/${f}`).mtimeMs > sinceMs;
        } catch {
          return false;
        }
      }).length;
    } catch {
      return 0;
    }
  },

  notify(title: string, message: string): void {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    Bun.spawn(["/usr/bin/osascript", "-e", `display notification "${esc(message)}" with title "${esc(title)}"`], {
      stdout: "ignore",
      stderr: "ignore",
    });
  },
};
