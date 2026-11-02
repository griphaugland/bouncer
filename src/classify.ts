import { basename } from "node:path";

// Tools with hand-written rules below. `bun` is deliberately absent: Bouncer itself is built
// with it, and gating its own build would be a footgun.
export const BUILTIN_TOOLS = ["dotnet", "pnpm", "npm", "npx", "yarn", "xcodebuild"] as const;

/**
 * Generic tools: a subcommand list per tool, configurable under `tools:` in policy.yaml.
 * An entry may be several words ("compose build") and matches the leading positional args.
 */
export interface ToolRule {
  slot: string;
  heavy: string[];
}
export type ToolRules = Record<string, ToolRule>;

export const DEFAULT_TOOL_RULES: ToolRules = {
  cargo: { slot: "rust", heavy: ["build", "b", "test", "t", "run", "r", "check", "c", "clippy", "bench", "install", "doc"] },
  go: { slot: "go", heavy: ["build", "test", "run", "install", "vet", "generate"] },
  swift: { slot: "xcode", heavy: ["build", "test", "run"] },
  gradle: { slot: "jvm", heavy: ["build", "test", "assemble", "check", "bootRun", "run"] },
  mvn: { slot: "jvm", heavy: ["compile", "test", "package", "verify", "install", "spring-boot:run"] },
  docker: { slot: "docker", heavy: ["build", "buildx build", "compose build"] },
};

/** Every tool that gets a shim: the built-ins plus whatever the policy defines. */
export function shimmedTools(rules: ToolRules = DEFAULT_TOOL_RULES): string[] {
  return [...new Set([...BUILTIN_TOOLS, ...Object.keys(rules)])];
}

const LIGHT_FLAGS = new Set(["--version", "-V", "--help", "-h", "help", "version"]);

function classifyGeneric(rule: ToolRule, args: string[]): string | null {
  if (args.some((a) => LIGHT_FLAGS.has(a))) return null;
  const pos = args.filter((a) => !a.startsWith("-"));
  for (const entry of rule.heavy) {
    const words = entry.split(/\s+/);
    if (words.every((w, i) => pos[i] === w)) return rule.slot;
  }
  return null;
}

const DOTNET_HEAVY = new Set([
  "build", "test", "run", "publish", "pack", "watch", "restore", "msbuild", "clean", "vstest", "format", "ef",
]);

// Long-running dev servers would hold a slot forever, so they are never gated.
const JS_LONG_RUNNING = new Set(["dev", "start", "serve", "preview"]);

const JS_HEAVY_NAMES = new Set([
  "install", "i", "ci", "add", "build", "test", "t", "vitest", "jest", "tsc", "lint", "eslint",
  "typecheck", "type-check", "check", "e2e", "playwright", "turbo", "next", "vite", "storybook",
]);
const JS_HEAVY_PATTERN = /(build|test|lint|typecheck|type-check|tsc|e2e)/;

const JS_FLAGS_WITH_VALUE = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "--workspace", "--cwd"]);
const JS_SCRIPT_RUNNERS = new Set(["run", "run-script", "exec", "x", "dlx"]);

const XCODEBUILD_INFO_FLAGS = new Set(["-version", "-list", "-showsdks", "-showBuildSettings", "-help", "-usage"]);

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (JS_FLAGS_WITH_VALUE.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function classifyJsName(name: string | undefined, rest: string[], args: string[]): string | null {
  if (!name) return null;
  if (args.includes("--watch")) return null;
  if (JS_LONG_RUNNING.has(name) || rest.some((r) => JS_LONG_RUNNING.has(r))) return null;
  if (JS_HEAVY_NAMES.has(name) || JS_HEAVY_PATTERN.test(name)) return "node";
  return null;
}

/** Which slot an invocation of a shimmed tool needs, or null if it is light and runs ungated. */
export function classifyInvocation(tool: string, args: string[], rules: ToolRules = DEFAULT_TOOL_RULES): string | null {
  switch (tool) {
    case "dotnet": {
      const first = args.find((a) => !a.startsWith("-"));
      if (!first) return null;
      if (DOTNET_HEAVY.has(first) || first.endsWith(".dll")) return "dotnet";
      return null;
    }
    case "xcodebuild":
      return args.some((a) => XCODEBUILD_INFO_FLAGS.has(a)) ? null : "xcode";
    case "npx": {
      const pos = positionals(args);
      return classifyJsName(pos[0], pos.slice(1), args);
    }
    case "pnpm":
    case "npm":
    case "yarn": {
      const pos = positionals(args);
      const sub = pos[0];
      // Bare `yarn` installs; bare `pnpm` / `npm` print help.
      if (!sub) return tool === "yarn" ? "node" : null;
      if (JS_SCRIPT_RUNNERS.has(sub)) return classifyJsName(pos[1], pos.slice(2), args);
      return classifyJsName(sub, pos.slice(1), args);
    }
    default: {
      const rule = rules[tool];
      return rule ? classifyGeneric(rule, args) : null;
    }
  }
}

/**
 * Best-effort scan of a shell command string (from a Claude Code Bash call) for heavy
 * invocations. Used only to decide whether to move the call to the background; the shim
 * makes the real decision, so a miss here costs a foreground wait, never a crash.
 */
export function classifyCommandString(command: string, rules: ToolRules = DEFAULT_TOOL_RULES): string[] {
  const tools = new Set(shimmedTools(rules));
  const slots = new Set<string>();
  for (const rawSegment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens = rawSegment
      .trim()
      .replace(/^[({\s]+/, "")
      .split(/\s+/)
      .map((t) => t.replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    let i = 0;
    let bypass = false;
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        if (t.startsWith("BOUNCER_BYPASS=")) bypass = true;
        i++;
      } else if (t === "env" || t === "time" || t === "command" || t === "exec" || t === "nice") {
        i++;
      } else break;
    }
    if (bypass || i >= tokens.length) continue;
    const tool = basename(tokens[i]!);
    if (!tools.has(tool)) continue;
    const slot = classifyInvocation(tool, tokens.slice(i + 1), rules);
    if (slot) slots.add(slot);
  }
  return [...slots];
}
