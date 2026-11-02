import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { shimmedTools } from "./classify";
import { ask } from "./conn";
import { LAUNCHD_LABEL, paths } from "./paths";
import { loadPolicy } from "./policy";
import { VERSION } from "./version";

// `bouncer doctor`: every way an install can be quietly broken on someone else's machine,
// each with the fix. Exit code 1 when anything fails, so it works in scripts and issues.

type Level = "ok" | "warn" | "fail";
interface Check {
  level: Level;
  title: string;
  fix?: string;
}

const tty = process.stdout.isTTY;
const mark: Record<Level, string> = tty
  ? { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m!\x1b[0m", fail: "\x1b[31m✗\x1b[0m" }
  : { ok: "ok  ", warn: "warn", fail: "FAIL" };

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** PATH and `command -v` results as a fresh login shell sees them, i.e. as new agent sessions will. */
function loginShell(script: string): string {
  const shell = process.env.SHELL || "/bin/zsh";
  const r = Bun.spawnSync([shell, "-ilc", script], {
    stdout: "pipe",
    stderr: "ignore",
    env: { HOME: homedir(), TERM: "dumb" },
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

  // Permissions
  if (existsSync(paths.home)) {
    const m = mode(paths.home);
    if (m & 0o077)
      add("fail", `${paths.home} is readable by other users (mode ${m.toString(8)})`, `chmod 700 ${paths.home}`);
    else add("ok", `${paths.home} is private (700)`);
  }

  // Daemon
  const launchd = Bun.spawnSync(["/bin/launchctl", "print", `gui/${process.getuid?.()}/${LAUNCHD_LABEL}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (launchd.exitCode === 0) add("ok", `launchd job ${LAUNCHD_LABEL} loaded`);
  else add("fail", `launchd job ${LAUNCHD_LABEL} not loaded`, "run `bouncer install`");
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
  const out = loginShell(
    `echo "${marker}PATH=$PATH"; for t in ${tools.join(" ")}; do printf "${marker}%s=%s\\n" "$t" "$(command -v $t 2>/dev/null)"; done`,
  );
  const lines = out
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

  // Claude Code hooks
  const settingsFiles = [join(homedir(), ".claude", "settings.json")];
  if (process.env.CLAUDE_CONFIG_DIR) settingsFiles.push(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"));
  const seen = new Set<string>();
  for (const file of settingsFiles) {
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    try {
      const text = readFileSync(file, "utf8");
      const settings = JSON.parse(text);
      const hasPre = JSON.stringify(settings.hooks?.PreToolUse ?? []).includes("bouncer hook pre-tool");
      const hasPrompt = JSON.stringify(settings.hooks?.UserPromptSubmit ?? []).includes("bouncer hook prompt");
      if (hasPre && hasPrompt) add("ok", `Claude Code hooks in ${file.replace(homedir(), "~")}`);
      else add("warn", `Claude Code hooks missing in ${file.replace(homedir(), "~")}`, "run `bouncer install`");
    } catch {
      add("warn", `could not parse ${file}`);
    }
  }
  if (!seen.size) add("ok", "no Claude Code settings found (hooks skipped; shims still gate builds)");

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
    console.log(`${mark[c.level]} ${c.title}`);
    if (c.fix && c.level !== "ok") console.log(`    ${tty ? "\x1b[2m" : ""}fix: ${c.fix}${tty ? "\x1b[0m" : ""}`);
  }
  const failed = checks.filter((c) => c.level === "fail").length;
  console.log(`\nbouncer ${VERSION} · ${failed ? `${failed} problem(s)` : "all good"}`);
  if (failed) process.exit(1);
}
