import { existsSync } from "node:fs";
import { join } from "node:path";
import { backup, hasBlock, readJson, setBlock, writeJson } from "./files";
import { paths, userHome } from "./paths";

// The coding agents Bouncer can connect to, and what "connected" means for each. Every agent's
// builds are queued by the PATH shims regardless; this is what goes on top. Each integration
// uses only what that agent documents (checked 2026-11-02):
//
//   Claude Code  hooks: PreToolUse can rewrite a call (→ run queued builds in the background),
//                UserPromptSubmit (→ "prioritize this"); statusline
//   Codex        hooks in $CODEX_HOME/hooks.json, on by default but each must be trusted once in
//                /hooks; same event shapes; no background runs. Global notes in AGENTS.md.
//   Gemini CLI   hooks are experimental and opt-in, so only a note in ~/.gemini/GEMINI.md
//   Grok, others no documented hooks or global instructions: shims only

export type Level = "full" | "hooks" | "guided" | "shims";

export const LEVEL_TEXT: Record<Level, string> = {
  full: "queued builds run in the background, priority, statusline",
  hooks: "priority + guardrails; queued builds wait in the foreground",
  guided: "told how the queue works; builds queued by shims",
  shims: "builds queued by shims",
};

export interface Agent {
  id: string;
  name: string;
  level: Level;
  /** Where it was found, or null if not on this Mac. */
  detect(): string | null;
  /** Files changed, as human-readable lines. */
  connect(): string[];
  disconnect(): string[];
  /** Whether Bouncer's integration is in place right now (for doctor). */
  connected(): boolean;
  /** One thing the user has to do in the agent itself, if any. */
  followUp?: string;
}

const BLOCK_START = "<!-- bouncer:start -->";
const BLOCK_END = "<!-- bouncer:end -->";

/** What an agent without hooks needs to know so it doesn't fight the queue. */
export const AGENT_NOTE = `## Bouncer (build queue on this Mac)

Heavy builds and tests (dotnet, pnpm/npm, cargo, go, xcodebuild, …) go through Bouncer, which
makes them wait their turn so parallel agents don't run the machine out of memory.

- A command may print \`[bouncer] queued job … position N\` and wait. That is expected: let it
  wait. Don't cancel it, retry it, or look for a way around the queue.
- Never set \`BOUNCER_BYPASS\`, and never run \`bouncer prioritize\`, \`cancel\`, \`unschedule\`,
  \`uninstall\` or \`clean --apply\`. Those are for the user.
- If the work is urgent, ask the user to say "prioritize this".
- \`bouncer status\` shows what is running and waiting, and why.`;

// --- hook groups shared by Claude Code and Codex (same shape) -----------------------------------

type Handler = { type: string; command: string; timeout?: number };
type Group = { matcher?: string; hooks: Handler[] };
/** Matches Bouncer's hook commands, quoted (current) or unquoted (installed by 0.1-0.4). */
export function isBouncerHook(command: string | undefined): boolean {
  return /bouncer"?\s+hook\s+(pre-tool|prompt)\b/.test(command ?? "");
}

function withoutBouncer(groups: Group[] | undefined): Group[] {
  return (groups ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isBouncerHook(h.command)) }))
    .filter((g) => g.hooks.length > 0);
}

function setHooks(hooks: Record<string, Group[]>, agentFlag: string, add: boolean): Record<string, Group[]> {
  const next = { ...hooks };
  next.PreToolUse = withoutBouncer(next.PreToolUse);
  next.UserPromptSubmit = withoutBouncer(next.UserPromptSubmit);
  if (add) {
    next.PreToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: `"${paths.binary}" hook pre-tool${agentFlag}`, timeout: 5 }],
    });
    next.UserPromptSubmit.push({
      hooks: [{ type: "command", command: `"${paths.binary}" hook prompt${agentFlag}`, timeout: 5 }],
    });
  }
  for (const key of ["PreToolUse", "UserPromptSubmit"]) if (!next[key]?.length) delete next[key];
  return next;
}

function hasBouncerHooks(hooks: Record<string, Group[]> | undefined): boolean {
  return (hooks?.PreToolUse ?? []).some((g) => (g.hooks ?? []).some((h) => isBouncerHook(h.command)));
}

// --- Claude Code -------------------------------------------------------------------------------

/** The default profile plus CLAUDE_CONFIG_DIR. A Claude Code that was never configured gets a settings file. */
export function claudeSettingsFiles(): string[] {
  const dirs = new Set([join(userHome(), ".claude")]);
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(process.env.CLAUDE_CONFIG_DIR);
  return [...dirs].filter((d) => existsSync(d)).map((d) => join(d, "settings.json"));
}

// Appended verbatim to an existing statusLine command, so uninstall can strip exactly this.
const STATUS_SUFFIX = `; printf ' '; "${paths.binary}" status --segment 2>/dev/null`;
const STATUS_ONLY = `"${paths.binary}" status --segment 2>/dev/null`;

function setStatusLine(settings: Record<string, any>, add: boolean): void {
  const current: string | undefined = settings.statusLine?.type === "command" ? settings.statusLine.command : undefined;
  if (current === STATUS_ONLY) delete settings.statusLine;
  else if (current?.endsWith(STATUS_SUFFIX)) settings.statusLine.command = current.slice(0, -STATUS_SUFFIX.length);
  if (!add) return;
  if (settings.statusLine?.type === "command") settings.statusLine.command += STATUS_SUFFIX;
  else if (!settings.statusLine) settings.statusLine = { type: "command", command: STATUS_ONLY };
}

function editClaude(add: boolean, statusLine: boolean): string[] {
  const changed: string[] = [];
  for (const file of claudeSettingsFiles()) {
    const settings = readJson(file);
    const before = JSON.stringify(settings);
    settings.hooks = setHooks(settings.hooks ?? {}, "", add);
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    setStatusLine(settings, add && statusLine);
    if (JSON.stringify(settings) === before) continue;
    backup(file);
    writeJson(file, settings);
    changed.push(file);
  }
  return changed;
}

// --- Codex ---------------------------------------------------------------------------------------

function codexHome(): string {
  return process.env.CODEX_HOME || join(userHome(), ".codex");
}

/** Codex reads AGENTS.override.md instead of AGENTS.md when it exists, so the note goes where it's read. */
function codexInstructionsFile(): string {
  const override = join(codexHome(), "AGENTS.override.md");
  return existsSync(override) ? override : join(codexHome(), "AGENTS.md");
}

function editCodex(add: boolean): string[] {
  const changed: string[] = [];
  const file = join(codexHome(), "hooks.json");
  const config = readJson(file);
  const before = JSON.stringify(config);
  config.hooks = setHooks(config.hooks ?? {}, " --agent codex", add);
  if (!Object.keys(config.hooks).length) delete config.hooks;
  if (JSON.stringify(config) !== before) {
    backup(file);
    writeJson(file, config);
    changed.push(file);
  }
  if (setBlock(codexInstructionsFile(), BLOCK_START, BLOCK_END, add ? AGENT_NOTE : null)) {
    changed.push(codexInstructionsFile());
  }
  return changed;
}

// --- registry ------------------------------------------------------------------------------------

// Terminal apps put wrapper scripts for agents on PATH (cmux ships ones for amp, grok, codex,
// claude…). Those aren't installs.
const WRAPPER_DIRS = [/\/cmux-cli-shims\//, /\/cmux\.app\/Contents\/Resources\/bin\//];

function onPath(...names: string[]): string | null {
  for (const n of names) {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (!dir || dir === paths.shimDir) continue;
      const candidate = join(dir, n);
      if (WRAPPER_DIRS.some((re) => re.test(`${candidate}`))) continue;
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface ConnectOptions {
  statusLine: boolean;
}

export function agents(opts: ConnectOptions = { statusLine: true }): Agent[] {
  const home = userHome();
  const gemini = join(home, ".gemini", "GEMINI.md");
  const shimsOnly = (id: string, name: string, ...bins: string[]): Agent => ({
    id,
    name,
    level: "shims",
    detect: () => onPath(...bins),
    connect: () => [],
    disconnect: () => [],
    connected: () => true,
  });
  return [
    {
      id: "claude",
      name: "Claude Code",
      level: "full",
      detect: () => (claudeSettingsFiles().length ? join(home, ".claude") : onPath("claude")),
      connect: () => editClaude(true, opts.statusLine),
      disconnect: () => editClaude(false, false),
      connected: () => claudeSettingsFiles().some((f) => hasBouncerHooks(readJson(f).hooks)),
    },
    {
      id: "codex",
      name: "Codex",
      level: "hooks",
      detect: () => (existsSync(codexHome()) ? codexHome() : onPath("codex")),
      connect: () => editCodex(true),
      disconnect: () => editCodex(false),
      connected: () => hasBouncerHooks(readJson(join(codexHome(), "hooks.json")).hooks),
      followUp: "In Codex, run /hooks once and trust Bouncer's two hooks (Codex skips untrusted hooks).",
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      level: "guided",
      detect: () => (existsSync(join(home, ".gemini")) ? join(home, ".gemini") : onPath("gemini")),
      connect: () => (setBlock(gemini, BLOCK_START, BLOCK_END, AGENT_NOTE) ? [gemini] : []),
      disconnect: () => (setBlock(gemini, BLOCK_START, BLOCK_END, null) ? [gemini] : []),
      connected: () => hasBlock(gemini, BLOCK_START),
    },
    shimsOnly("grok", "Grok", "grok"),
    shimsOnly("cursor", "Cursor Agent", "cursor-agent"),
    shimsOnly("opencode", "OpenCode", "opencode"),
    shimsOnly("amp", "Amp", "amp"),
    shimsOnly("aider", "Aider", "aider"),
  ];
}
