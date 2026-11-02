import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TOOL_RULES, type ToolRules } from "./classify";
import { paths } from "./paths";

export interface Policy {
  /** Heavy jobs allowed at once across all slots. */
  maxConcurrent: number;
  /** Jobs allowed at once per slot. Unknown slots get 1. */
  slots: Record<string, number>;
  gate: {
    /** Below this % of free memory: one heavy job at a time. */
    yellowFreePercent: number;
    /** Below this % of free memory: nothing new starts and the newest job is reaped. */
    redFreePercent: number;
  };
  reaper: {
    /** Minimum gap between two reaps, so memory has time to recover. */
    cooldownSeconds: number;
    /** Kill VBCSCompiler / MSBuild nodes this long after the last dotnet job ends. */
    compilerServerIdleSeconds: number;
    /** Hard kill a job that ignored SIGTERM for this long. */
    stopGraceSeconds: number;
    /** Kill idle dotnet compiler servers (VBCSCompiler, MSBuild nodes). */
    killCompilerServers: boolean;
  };
  /** Let heavy builds Bouncer didn't start (IDE, old sessions) occupy slots. */
  countOutsideBuilds: boolean;
  /** macOS notifications for memory-critical, out-of-memory events and finished scheduled jobs. */
  notifications: boolean;
  priority: {
    /** How long "prioritize this" keeps a session at the front. */
    minutes: number;
  };
  /** Extra tools to gate (cargo, go, ...), merged over the defaults. `name: false` removes one. */
  tools: ToolRules;
  janitor: {
    /** Where `bouncer clean` looks for git worktrees. */
    roots: string[];
    /** A worktree untouched this long counts as idle. */
    staleDays: number;
    /** Below this much free disk, `bouncer status` advises cleaning. macOS swaps to this disk. */
    minFreeDiskGb: number;
  };
}

export const DEFAULT_POLICY: Policy = {
  maxConcurrent: 2,
  slots: { dotnet: 1, node: 2, xcode: 1, rust: 1, go: 1, jvm: 1, docker: 1 },
  gate: { yellowFreePercent: 25, redFreePercent: 12 },
  reaper: { cooldownSeconds: 30, compilerServerIdleSeconds: 30, stopGraceSeconds: 10, killCompilerServers: true },
  countOutsideBuilds: true,
  notifications: true,
  priority: { minutes: 60 },
  tools: DEFAULT_TOOL_RULES,
  janitor: { roots: [join(homedir(), "Documents")], staleDays: 14, minFreeDiskGb: 40 },
};

function parseTools(raw: unknown): ToolRules {
  const tools: ToolRules = { ...DEFAULT_TOOL_RULES };
  for (const [name, value] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`policy: tools.${name} is not a valid command name`);
    if (value === false || value === null) {
      delete tools[name];
      continue;
    }
    const v = value as { slot?: unknown; heavy?: unknown };
    if (typeof v.slot !== "string" || !Array.isArray(v.heavy) || !v.heavy.every((h) => typeof h === "string")) {
      throw new Error(`policy: tools.${name} needs a slot (string) and heavy (list of subcommands)`);
    }
    tools[name] = { slot: v.slot, heavy: v.heavy as string[] };
  }
  return tools;
}

export const DEFAULT_POLICY_YAML = `# Bouncer policy. The daemon picks up edits within a few seconds.
#
# Gate is decided by the kernel's memory pressure level and the % of free memory.
# Swap is shown in \`bouncer status\` but never gates: macOS keeps swap full long
# after the pressure is gone.

# Heavy jobs allowed at once across all slots.
maxConcurrent: ${DEFAULT_POLICY.maxConcurrent}

# Jobs allowed at once per slot.
slots:
  dotnet: ${DEFAULT_POLICY.slots.dotnet}   # dotnet build/test/run, incl. the compiler servers they spawn
  node: ${DEFAULT_POLICY.slots.node}     # pnpm/npm/yarn/npx build, test, lint, tsc, install
  xcode: ${DEFAULT_POLICY.slots.xcode}    # xcodebuild, swift build/test
  rust: 1     # cargo
  go: 1
  jvm: 1      # gradle, mvn
  docker: 1   # docker build

gate:
  yellowFreePercent: ${DEFAULT_POLICY.gate.yellowFreePercent}   # below: one heavy job at a time (or pressure level "warn")
  redFreePercent: ${DEFAULT_POLICY.gate.redFreePercent}      # below: nothing starts, newest job reaped (or pressure "critical")

reaper:
  cooldownSeconds: ${DEFAULT_POLICY.reaper.cooldownSeconds}
  compilerServerIdleSeconds: ${DEFAULT_POLICY.reaper.compilerServerIdleSeconds}
  stopGraceSeconds: ${DEFAULT_POLICY.reaper.stopGraceSeconds}
  killCompilerServers: ${DEFAULT_POLICY.reaper.killCompilerServers}   # VBCSCompiler / MSBuild nodes once dotnet is idle

notifications: ${DEFAULT_POLICY.notifications}

# Builds Bouncer didn't start (IDE, sessions from before install) hold slots. Turn off if it
# mistakes something long-running for a build.
countOutsideBuilds: ${DEFAULT_POLICY.countOutsideBuilds}

priority:
  minutes: ${DEFAULT_POLICY.priority.minutes}

# Gate more tools. Built in: cargo, go, swift, gradle, mvn, docker (see \`bouncer doctor\`).
# Add your own, or set one to false to stop gating it. Run \`bouncer shims\` after editing.
# tools:
#   bazel: { slot: jvm, heavy: [build, test, run] }
#   docker: false

# \`bouncer clean\`: where to look for worktrees and when one counts as idle.
janitor:
  roots: [${DEFAULT_POLICY.janitor.roots.map((r) => `"${r.replace(homedir(), "~")}"`).join(", ")}]
  staleDays: ${DEFAULT_POLICY.janitor.staleDays}
  minFreeDiskGb: ${DEFAULT_POLICY.janitor.minFreeDiskGb}   # below: \`bouncer status\` advises cleaning (macOS swaps to this disk)
`;

function positive(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`policy: ${name} must be a positive number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function bool(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new Error(`policy: ${name} must be true or false, got ${JSON.stringify(value)}`);
  return value;
}

export function parsePolicy(raw: unknown): Policy {
  const r = (raw ?? {}) as Record<string, any>;
  const d = DEFAULT_POLICY;
  const slots: Record<string, number> = { ...d.slots };
  for (const [name, cap] of Object.entries(r.slots ?? {})) {
    slots[name] = Math.floor(positive(cap, 1, `slots.${name}`));
  }
  const policy: Policy = {
    maxConcurrent: Math.floor(positive(r.maxConcurrent, d.maxConcurrent, "maxConcurrent")),
    slots,
    gate: {
      yellowFreePercent: positive(r.gate?.yellowFreePercent, d.gate.yellowFreePercent, "gate.yellowFreePercent"),
      redFreePercent: positive(r.gate?.redFreePercent, d.gate.redFreePercent, "gate.redFreePercent"),
    },
    reaper: {
      cooldownSeconds: positive(r.reaper?.cooldownSeconds, d.reaper.cooldownSeconds, "reaper.cooldownSeconds"),
      compilerServerIdleSeconds: positive(
        r.reaper?.compilerServerIdleSeconds,
        d.reaper.compilerServerIdleSeconds,
        "reaper.compilerServerIdleSeconds",
      ),
      stopGraceSeconds: positive(r.reaper?.stopGraceSeconds, d.reaper.stopGraceSeconds, "reaper.stopGraceSeconds"),
      killCompilerServers: bool(
        r.reaper?.killCompilerServers,
        d.reaper.killCompilerServers,
        "reaper.killCompilerServers",
      ),
    },
    countOutsideBuilds: bool(r.countOutsideBuilds, d.countOutsideBuilds, "countOutsideBuilds"),
    notifications: bool(r.notifications, d.notifications, "notifications"),
    priority: { minutes: positive(r.priority?.minutes, d.priority.minutes, "priority.minutes") },
    tools: parseTools(r.tools),
    janitor: {
      roots: Array.isArray(r.janitor?.roots)
        ? r.janitor.roots.map((p: unknown) => String(p).replace(/^~(?=\/|$)/, homedir()))
        : d.janitor.roots,
      staleDays: positive(r.janitor?.staleDays, d.janitor.staleDays, "janitor.staleDays"),
      minFreeDiskGb: positive(r.janitor?.minFreeDiskGb, d.janitor.minFreeDiskGb, "janitor.minFreeDiskGb"),
    },
  };
  if (policy.gate.redFreePercent >= policy.gate.yellowFreePercent) {
    throw new Error("policy: gate.redFreePercent must be lower than gate.yellowFreePercent");
  }
  return policy;
}

export function loadPolicy(file = paths.policy): Policy {
  if (!existsSync(file)) return DEFAULT_POLICY;
  return parsePolicy(Bun.YAML.parse(readFileSync(file, "utf8")));
}
