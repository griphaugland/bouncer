import { existsSync, readFileSync } from "node:fs";
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
  };
  priority: {
    /** How long "prioritize this" keeps a session at the front. */
    minutes: number;
  };
}

export const DEFAULT_POLICY: Policy = {
  maxConcurrent: 2,
  slots: { dotnet: 1, node: 2, xcode: 1 },
  gate: { yellowFreePercent: 25, redFreePercent: 12 },
  reaper: { cooldownSeconds: 30, compilerServerIdleSeconds: 30, stopGraceSeconds: 10 },
  priority: { minutes: 60 },
};

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
  xcode: ${DEFAULT_POLICY.slots.xcode}    # xcodebuild

gate:
  yellowFreePercent: ${DEFAULT_POLICY.gate.yellowFreePercent}   # below: one heavy job at a time (or pressure level "warn")
  redFreePercent: ${DEFAULT_POLICY.gate.redFreePercent}      # below: nothing starts, newest job reaped (or pressure "critical")

reaper:
  cooldownSeconds: ${DEFAULT_POLICY.reaper.cooldownSeconds}
  compilerServerIdleSeconds: ${DEFAULT_POLICY.reaper.compilerServerIdleSeconds}
  stopGraceSeconds: ${DEFAULT_POLICY.reaper.stopGraceSeconds}

priority:
  minutes: ${DEFAULT_POLICY.priority.minutes}
`;

function positive(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`policy: ${name} must be a positive number, got ${JSON.stringify(value)}`);
  }
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
    },
    priority: { minutes: positive(r.priority?.minutes, d.priority.minutes, "priority.minutes") },
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
