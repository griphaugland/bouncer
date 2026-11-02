import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { agents } from "./agents";
import { shimmedTools } from "./classify";
import { ask } from "./conn";
import { readJson } from "./files";
import { homebrewInstall } from "./install";
import { describe, recommend, scanMachine } from "./machine";
import { launchdLabel, paths, userHome } from "./paths";
import { loadPolicy } from "./policy";
import { mark, out } from "./term";
import { VERSION } from "./version";

// `bouncer doctor`: every way an install can be quietly broken on someone else's machine,
// each with the fix. Exit code 1 when anything fails, so it works in scripts and issues.

// "note" is an instruction for the user, not a finding: shown, never counted as a warning.
type Level = "ok" | "note" | "warn" | "fail";
interface Check {
  level: Level;
  title: string;
  fix?: string;
}

const glyph: Record<Level, () => string> = { ok: mark.ok, note: mark.arrow, warn: mark.warn, fail: mark.fail };

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** PATH and `command -v` results as a fresh login shell sees them, i.e. as new agent sessions will. */
function loginShell(script: string): string {
  const shell = process.env.SHELL || "/bin/zsh";
  const r = Bun.spawnSync([shell, "-ilc", script], {
    stdout: "pipe",
    stderr: "ignore",
    env: { HOME: userHome(), TERM: "dumb" },
  });
  return r.stdout.toString();
}

export async function doctorCommand(): Promise<void> {
  const checks: Check[] = [];
  const add = (level: Level, title: string, fix?: string) => checks.push({ level, title, fix });

  // Installed binary
  if (!existsSync(paths.binary)) {
    add(
      "fail",
      `not installed (${paths.binary} missing)`,
      "run `bouncer install` from a release or `bun run install-local`",
    );
  } else {
    const installed = Bun.spawnSync([paths.binary, "--version"], { stdout: "pipe" }).stdout.toString().trim();
    if (installed === VERSION) add("ok", `installed binary v${installed}`);
    else
      add(
        "warn",
        `installed binary is v${installed}, this one is v${VERSION}`,
        "run `bouncer install` with the version you want",
      );
  }

  // Homebrew: the daemon copies `brew upgrade`s over only if it knows to follow Homebrew's binary.
  const brew = homebrewInstall();
  if (brew && existsSync(paths.binary)) {
    const source = existsSync(paths.source) ? readFileSync(paths.source, "utf8").trim() : "";
    if (source === brew) add("ok", "follows Homebrew upgrades");
    else
      add(
        "warn",
        "installed with Homebrew, but the daemon runs a separate copy that `brew upgrade` won't update",
        "run `bouncer setup` once (your choices are kept)",
      );
  }

  // Permissions
  if (existsSync(paths.home)) {
    const m = mode(paths.home);
    if (m & 0o077)
      add("fail", `${paths.home} is readable by other users (mode ${m.toString(8)})`, `chmod 700 ${paths.home}`);
    else add("ok", `${paths.home} is private (700)`);
  }

  // Daemon
  const launchd = Bun.spawnSync(["/bin/launchctl", "print", `gui/${process.getuid?.()}/${launchdLabel()}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (launchd.exitCode === 0) add("ok", `launchd job ${launchdLabel()} loaded`);
  else add("fail", `launchd job ${launchdLabel()} not loaded`, "run `bouncer install`");
  const reply = await ask({ op: "status" }, 1500);
  if (reply?.type === "status") {
    const s = reply.status;
    if (s.version === VERSION) add("ok", `daemon answering (v${s.version}, pid ${s.pid}, load ${s.load})`);
    else
      add(
        "warn",
        `daemon answering but runs v${s.version ?? "?"}, CLI is v${VERSION}`,
        "run `bouncer install` to restart it",
      );
    if (existsSync(paths.socket) && mode(paths.socket) & 0o077) {
      add("fail", "socket is accessible to other users", "restart the daemon: `bouncer install`");
    }
  } else {
    add(
      "fail",
      "daemon not answering on its socket",
      `check ${paths.log} and ${join(paths.home, "daemon.stdout.log")}`,
    );
  }

  // Policy
  let tools: string[] = [];
  try {
    tools = shimmedTools(loadPolicy().tools);
    add("ok", `policy valid (${existsSync(paths.policy) ? paths.policy : "defaults"})`);
  } catch (e) {
    add("fail", `policy invalid: ${(e as Error).message}`, `edit ${paths.policy}`);
    tools = shimmedTools();
  }

  // PATH, as a new shell sees it
  const marker = "__BOUNCER_DOCTOR__";
  const shellOutput = loginShell(
    `echo "${marker}PATH=$PATH"; for t in ${tools.join(" ")}; do printf "${marker}%s=%s\\n" "$t" "$(command -v $t 2>/dev/null)"; done`,
  );
  const lines = shellOutput
    .split("\n")
    .filter((l) => l.startsWith(marker))
    .map((l) => l.slice(marker.length));
  const loginPath = lines.find((l) => l.startsWith("PATH="))?.slice(5) ?? "";
  if (!loginPath.split(":").includes(paths.shimDir)) {
    add(
      "fail",
      "shims are not on PATH in a new login shell",
      `add \`export PATH="${paths.shimDir}:$PATH"\` at the END of your shell rc, or rerun \`bouncer install\``,
    );
  } else {
    add("ok", "shims are on PATH in new shells");
    const shadowed: string[] = [];
    const missing: string[] = [];
    for (const l of lines) {
      const [tool, resolved] = [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)];
      if (tool === "PATH") continue;
      if (!resolved) missing.push(tool);
      else if (!resolved.startsWith(paths.shimDir)) shadowed.push(`${tool} → ${resolved}`);
    }
    if (shadowed.length) {
      add(
        "fail",
        `tools resolve past the shims: ${shadowed.join(", ")}`,
        "something later in your shell rc (often nvm or a version manager) prepends to PATH; move Bouncer's PATH line after it",
      );
    } else add("ok", "every gated tool resolves to its shim");
    if (missing.length) add("ok", `not installed here (nothing to gate): ${missing.join(", ")}`);
  }

  // Agents: each one chosen in setup must still be connected (an agent update or a hand edit can
  // drop hooks). Without a setup.json (pre-0.5 install), check whatever is installed.
  let chosen: string[] | null = null;
  try {
    chosen = (readJson(join(paths.home, "setup.json")).agents as string[] | undefined) ?? null;
  } catch {}
  for (const agent of agents()) {
    if (agent.level === "shims" || !agent.detect()) continue;
    const wanted = chosen ? chosen.includes(agent.id) : agent.id === "claude";
    if (!wanted) continue;
    try {
      if (agent.connected()) {
        add("ok", `${agent.name} connected`);
        if (agent.followUp) add("note", out.dim(agent.followUp));
      } else add("warn", `${agent.name} was chosen in setup but isn't connected`, "run `bouncer setup`");
    } catch (e) {
      add("warn", `could not read ${agent.name}'s config: ${(e as Error).message}`);
    }
  }

  // Policy vs this machine
  try {
    const machine = scanMachine();
    const sessions = (readJson(join(paths.home, "setup.json")).sessions as number | undefined) ?? 6;
    const tuned = recommend(machine, sessions);
    const policy = loadPolicy();
    if (policy.maxConcurrent > tuned.maxConcurrent + 1) {
      add(
        "warn",
        `policy allows ${policy.maxConcurrent} heavy jobs at once; this Mac (${machine.memoryGb} GB) is tuned for ${tuned.maxConcurrent}`,
        "`bouncer tune` to compare, `bouncer tune --apply` to adopt",
      );
    } else add("ok", `limits fit this Mac (${describe(machine)})`);
  } catch {}

  // Machine
  if (reply?.type === "status") {
    const s = reply.status;
    if (s.diskFreeGb >= 0 && s.diskFreeGb < 20)
      add("warn", `only ${s.diskFreeGb} GB disk free; macOS swaps there`, "`bouncer clean`");
    if (s.jetsamSinceStart > 0) {
      add(
        "warn",
        `${s.jetsamSinceStart} macOS out-of-memory event(s) since the daemon started`,
        `lower gate thresholds in ${paths.policy}`,
      );
    }
  }

  for (const c of checks) {
    console.log(`${glyph[c.level]()} ${c.level === "ok" ? c.title : out.bold(c.title)}`);
    if (c.fix && c.level !== "ok") console.log(`  ${out.dim(`fix: ${c.fix}`)}`);
  }
  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  const summary = failed
    ? out.red(`${failed} problem${failed === 1 ? "" : "s"}`)
    : warned
      ? out.yellow(`${warned} warning${warned === 1 ? "" : "s"}`)
      : out.green("all good");
  console.log(`\n${out.bold(`bouncer ${VERSION}`)} · ${summary}`);
  if (failed) process.exit(1);
}
