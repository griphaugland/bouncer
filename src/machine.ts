import { existsSync } from "node:fs";
import { join } from "node:path";
import { shimmedTools } from "./classify";
import { userHome } from "./paths";
import type { Policy } from "./policy";
import { resolveReal } from "./run";

// What Mac this is, and how much heavy work it can take at once. Read at install (and by
// `bouncer tune` / `doctor`), never on the hot path.

export interface MachineProfile {
  /** "MacBook Pro" when system_profiler answers, otherwise the model identifier. */
  name: string;
  model: string;
  chip: string;
  arch: "arm64" | "x86_64";
  /** Running an x86_64 binary under Rosetta on Apple Silicon. */
  translated: boolean;
  memoryGb: number;
  cores: number;
  /** Performance cores (all physical cores on Intel). */
  performanceCores: number;
  macos: string;
  toolchains: string[];
  agents: string[];
}

/** Bun-compiled binaries need macOS 13 (bun.sh/docs/installation); the menu bar app needs 14. */
export const MIN_MACOS = 13;

function sysctl(names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of names) {
    const r = Bun.spawnSync(["/usr/sbin/sysctl", "-n", name], { stdout: "pipe", stderr: "ignore" });
    if (r.exitCode === 0) out.set(name, r.stdout.toString().trim());
  }
  return out;
}

function marketing(): { name?: string; chip?: string } {
  const r = Bun.spawnSync(["/usr/sbin/system_profiler", "SPHardwareDataType", "-json", "-detailLevel", "mini"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5000,
  });
  try {
    const hw = JSON.parse(r.stdout.toString()).SPHardwareDataType?.[0] ?? {};
    return { name: hw.machine_name, chip: hw.chip_type ?? hw.cpu_type };
  } catch {
    return {};
  }
}

export function scanMachine(): MachineProfile {
  const s = sysctl([
    "hw.memsize",
    "hw.ncpu",
    "hw.physicalcpu",
    "hw.perflevel0.physicalcpu",
    "hw.model",
    "machdep.cpu.brand_string",
    "hw.optional.arm64",
    "sysctl.proc_translated",
  ]);
  const m = marketing();
  const appleSilicon = s.get("hw.optional.arm64") === "1";
  const macos = Bun.spawnSync(["/usr/bin/sw_vers", "-productVersion"], { stdout: "pipe" }).stdout.toString().trim();
  const home = userHome();
  const agents = [
    ["Claude Code", existsSync(join(home, ".claude")) || !!resolveReal("claude")],
    ["Codex", existsSync(join(home, ".codex")) || !!resolveReal("codex")],
    ["cmux", existsSync("/Applications/cmux.app") || existsSync(join(home, ".config", "cmux"))],
  ]
    .filter(([, present]) => present)
    .map(([name]) => name as string);
  return {
    name: m.name ?? s.get("hw.model") ?? "Mac",
    model: s.get("hw.model") ?? "unknown",
    chip: m.chip ?? s.get("machdep.cpu.brand_string") ?? "unknown",
    arch: appleSilicon ? "arm64" : "x86_64",
    translated: s.get("sysctl.proc_translated") === "1",
    memoryGb: Math.round(Number(s.get("hw.memsize") ?? 0) / 1024 ** 3),
    cores: Number(s.get("hw.ncpu") ?? 1),
    performanceCores: Number(s.get("hw.perflevel0.physicalcpu") ?? s.get("hw.physicalcpu") ?? 1),
    macos,
    toolchains: shimmedTools().filter((t) => !!resolveReal(t)),
    agents,
  };
}

export function macosMajor(version: string): number {
  return Number(version.split(".")[0]) || 0;
}

export interface Tuning {
  maxConcurrent: number;
  slots: Record<string, number>;
  gate: Policy["gate"];
  /** One line per decision, for the policy header and `bouncer tune`. */
  reasons: string[];
}

/**
 * How much heavy work fits at once. A heavy build (dotnet test with its compiler server, a
 * next build, a cargo build) commonly takes 3-6 GB; macOS, browsers and a dozen agent sessions
 * take 6-10 GB before any of that. These tiers are starting points: Bouncer reports every
 * macOS out-of-memory event, which is the signal to lower them.
 */
export function recommend(p: Pick<MachineProfile, "memoryGb" | "performanceCores">, sessions = 6): Tuning {
  // An agent session (CLI + its MCP servers) was measured at ~0.23 GB resident (26 sessions,
  // 5.9 GB, 2026-11-02). The tiers already allow for about six; more comes out of the budget.
  const sessionCost = Math.max(0, sessions - 6) * 0.25;
  const ram = Math.max(1, Math.round(p.memoryGb - sessionCost));
  const tier =
    ram < 12
      ? { max: 1, node: 1, dotnet: 1, why: `${ram} GB is tight: one heavy job at a time` }
      : ram < 24
        ? { max: 2, node: 2, dotnet: 1, why: `${ram} GB fits two heavy jobs next to your apps and agents` }
        : ram < 36
          ? { max: 3, node: 2, dotnet: 1, why: `${ram} GB fits three heavy jobs` }
          : ram < 64
            ? { max: 4, node: 3, dotnet: 2, why: `${ram} GB fits four heavy jobs, two of them dotnet` }
            : { max: 6, node: 4, dotnet: 2, why: `${ram} GB fits six heavy jobs` };
  const reasons = [tier.why];
  if (sessionCost >= 1) {
    reasons.unshift(`${p.memoryGb} GB, minus ~${sessionCost.toFixed(0)} GB for ${sessions} agent sessions`);
  }

  // Builds are CPU-bound too: past ~2 performance cores each, more parallel builds just slow
  // every one of them down.
  const byCores = Math.max(1, Math.floor(p.performanceCores / 2));
  let max = tier.max;
  if (byCores < max) {
    max = byCores;
    reasons.push(`capped at ${max} by ${p.performanceCores} performance cores`);
  }

  const small = p.memoryGb < 12;
  const gate = small ? { yellowFreePercent: 30, redFreePercent: 15 } : { yellowFreePercent: 25, redFreePercent: 12 };
  if (small) reasons.push("earlier warnings: less headroom before macOS starts swapping hard");

  return {
    maxConcurrent: max,
    slots: {
      dotnet: Math.min(tier.dotnet, max),
      node: Math.min(tier.node, max),
      xcode: 1,
      rust: 1,
      go: 1,
      jvm: 1,
      docker: 1,
    },
    gate,
    reasons,
  };
}

export function describe(p: MachineProfile): string {
  return `${p.name} · ${p.chip} · ${p.memoryGb} GB · ${p.cores} cores · macOS ${p.macos}`;
}
