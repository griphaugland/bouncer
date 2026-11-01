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
    for (const line of run(["/bin/ps", "-axo", "pid=,ppid=,rss=,command="]).split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), command: m[4]! });
    }
    return procs;
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
