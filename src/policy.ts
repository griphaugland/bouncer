import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TOOL_RULES, type ToolRules } from "./classify";
import { paths, userHome } from "./paths";

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
  janitor: { roots: [join(userHome(), "Documents")], staleDays: 14, minFreeDiskGb: 40 },
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

const SLOT_NOTES: Record<string, string> = {
  dotnet: "dotnet build/test/run, incl. the compiler servers they spawn",
  node: "pnpm/npm/yarn/npx build, test, lint, tsc, install",
  xcode: "xcodebuild, swift build/test",
  rust: "cargo",
  jvm: "gradle, mvn",
  docker: "docker build",
};

function toolsYaml(tools: ToolRules): string {
  const lines: string[] = [];
  for (const name of Object.keys(DEFAULT_TOOL_RULES)) {
    if (!tools[name]) lines.push(`  ${name}: false`);
  }
  for (const [name, rule] of Object.entries(tools)) {
    const builtin = DEFAULT_TOOL_RULES[name];
    if (builtin && JSON.stringify(builtin) === JSON.stringify(rule)) continue;
    lines.push(
      `  ${name}: { slot: ${JSON.stringify(rule.slot)}, heavy: [${rule.heavy.map((h) => JSON.stringify(h)).join(", ")}] }`,
    );
  }
  return lines.length
    ? `tools:\n${lines.join("\n")}`
    : "# tools:\n#   bazel: { slot: jvm, heavy: [build, test, run] }\n#   docker: false";
}

/** The policy as commented YAML. `header` lines (e.g. what Mac it was tuned for) go on top. */
export function renderPolicy(p: Policy, header: string[] = []): string {
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));
  const slots = Object.entries(p.slots)
    .map(([name, cap]) => {
      const line = `  ${name}: ${cap}`;
      return SLOT_NOTES[name] ? `${pad(line, 14)}# ${SLOT_NOTES[name]}` : line;
    })
    .join("\n");
  return `# Bouncer policy. The daemon picks up edits within a few seconds.
${header.map((h) => `# ${h}`).join("\n")}${header.length ? "\n" : ""}#
# Gate is decided by the kernel's memory pressure level and the % of free memory.
# Swap is shown in \`bouncer status\` but never gates: macOS keeps swap full long
# after the pressure is gone. Re-tune for this Mac any time: \`bouncer tune\`.

# Heavy jobs allowed at once across all slots.
maxConcurrent: ${p.maxConcurrent}

# Jobs allowed at once per slot.
slots:
${slots}

gate:
  yellowFreePercent: ${p.gate.yellowFreePercent}   # below: one heavy job at a time (or pressure level "warn")
  redFreePercent: ${p.gate.redFreePercent}      # below: nothing starts, newest job stopped (or pressure "critical")

reaper:
  cooldownSeconds: ${p.reaper.cooldownSeconds}
  compilerServerIdleSeconds: ${p.reaper.compilerServerIdleSeconds}
  stopGraceSeconds: ${p.reaper.stopGraceSeconds}
  killCompilerServers: ${p.reaper.killCompilerServers}   # VBCSCompiler / MSBuild nodes once dotnet is idle

notifications: ${p.notifications}

# Builds Bouncer didn't start (IDE, sessions from before install) hold slots. Turn off if it
# mistakes something long-running for a build.
countOutsideBuilds: ${p.countOutsideBuilds}

priority:
  minutes: ${p.priority.minutes}

# Gate more tools. Built in: cargo, go, swift, gradle, mvn, docker.
# Add your own, or set one to false to stop gating it. Run \`bouncer shims\` after editing.
${toolsYaml(p.tools)}

# \`bouncer clean\`: where to look for worktrees and when one counts as idle.
janitor:
  roots: [${p.janitor.roots.map((r) => JSON.stringify(r.replace(userHome(), "~"))).join(", ")}]
  staleDays: ${p.janitor.staleDays}
  minFreeDiskGb: ${p.janitor.minFreeDiskGb}   # below: \`bouncer status\` advises cleaning (macOS swaps to this disk)
`;
}

export const DEFAULT_POLICY_YAML = renderPolicy(DEFAULT_POLICY);

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
        ? r.janitor.roots.map((p: unknown) => String(p).replace(/^~(?=\/|$)/, userHome()))
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
