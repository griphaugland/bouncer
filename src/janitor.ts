import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ask } from "./conn";
import { paths, userHome } from "./paths";
import { loadPolicy } from "./policy";
import { resolveReal } from "./run";
import { mark, out } from "./term";

// Disk cleanup. Two rules keep it safe:
//  1. Caches are cleared by their own tools (pnpm store prune, npm cache clean, ...), never rm.
//  2. Inside worktrees, only directories git itself reports as ignored, in worktrees nobody has
//     touched for `janitor.staleDays` and no agent session is working in, are deleted.
// Everything else (stale worktrees, untracked output folders) is reported, never deleted.

const BUILD_DIRS = [
  "node_modules",
  "bin",
  "obj",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "playwright-report",
  "test-results",
];

interface Category {
  id: string;
  title: string;
  /** Opt-in categories are skipped by `--apply all`. */
  optIn?: boolean;
  /** The size shown is an upper bound (pnpm prune frees only unreferenced packages). */
  upTo?: boolean;
  note?: string;
  scan(): { bytes: number; detail?: string; targets?: string[] } | null;
  apply(targets: string[]): void;
}

function duBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const du = Bun.spawnSync(["/usr/bin/du", "-sk", path], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
  return (Number(du.split("\t")[0]) || 0) * 1024;
}

function runTool(tool: string, args: string[]): void {
  const real = resolveReal(tool);
  if (!real) throw new Error(`${tool} not found`);
  const res = Bun.spawnSync([real, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, BOUNCER_BYPASS: "1" },
  });
  if (res.exitCode !== 0) throw new Error(`${tool} ${args.join(" ")} exited ${res.exitCode}`);
}

function gb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export interface Worktree {
  path: string;
  gitdir: string;
  lastActivity: number;
}

/** Git worktrees under `roots`: directories whose `.git` is a file pointing at a gitdir. */
export function findWorktrees(roots: string[], maxDepth = 5): Worktree[] {
  const out: Worktree[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const res = Bun.spawnSync(
      [
        "/usr/bin/find",
        root,
        "-maxdepth",
        String(maxDepth),
        "-name",
        "node_modules",
        "-prune",
        "-o",
        "-name",
        ".git",
        "-type",
        "f",
        "-print",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    for (const gitFile of res.stdout.toString().split("\n").filter(Boolean)) {
      const path = gitFile.slice(0, -"/.git".length);
      const pointer = readFileSync(gitFile, "utf8")
        .match(/gitdir:\s*(.*)/)?.[1]
        ?.trim();
      if (!pointer) continue;
      const gitdir = resolve(path, pointer);
      let last = 0;
      for (const f of ["index", "HEAD", "logs/HEAD"]) {
        try {
          last = Math.max(last, statSync(join(gitdir, f)).mtimeMs);
        } catch {}
      }
      out.push({ path, gitdir, lastActivity: last });
    }
  }
  return out;
}

/** Build-output directories in a worktree that git confirms are ignored. */
export function ignoredBuildDirs(worktree: string): string[] {
  const nameArgs = BUILD_DIRS.flatMap((n, i) => (i ? ["-o", "-name", n] : ["-name", n]));
  const found = Bun.spawnSync(
    ["/usr/bin/find", worktree, "-maxdepth", "6", "-type", "d", "(", ...nameArgs, ")", "-prune", "-print"],
    { stdout: "pipe", stderr: "ignore" },
  )
    .stdout.toString()
    .split("\n")
    .filter(Boolean);
  if (!found.length) return [];
  const git = resolveReal("git") ?? "/usr/bin/git";
  const res = Bun.spawnSync([git, "--no-optional-locks", "-C", worktree, "check-ignore", "--stdin"], {
    stdin: new TextEncoder().encode(found.join("\n")),
    stdout: "pipe",
    stderr: "ignore",
  });
  const ignored = new Set(res.stdout.toString().split("\n").filter(Boolean));
  return found.filter((p) => ignored.has(p));
}

/** `git status --porcelain` lines, or null when git cannot read the worktree (never "clean"). */
function porcelain(worktree: string): string[] | null {
  const git = resolveReal("git") ?? "/usr/bin/git";
  const out = Bun.spawnSync([git, "--no-optional-locks", "-C", worktree, "status", "--porcelain"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (out.exitCode !== 0) return null;
  return out.stdout.toString().split("\n").filter(Boolean);
}

const { dim, yellow, bold } = out;

/** The biggest untracked top-level folder, e.g. a 45 GB `output/` someone forgot. */
function largestUntracked(worktree: string, lines: string[]): { path: string; bytes: number } | null {
  let best: { path: string; bytes: number } | null = null;
  for (const l of lines) {
    if (!l.startsWith("?? ") || !l.endsWith("/")) continue;
    const rel = l.slice(3);
    const bytes = duBytes(join(worktree, rel));
    if (!best || bytes > best.bytes) best = { path: rel, bytes };
  }
  return best && best.bytes >= 1024 ** 3 ? best : null;
}

async function activeSessionDirs(): Promise<string[]> {
  const reply = await ask({ op: "status" }, 1500);
  if (reply?.type !== "status") return [];
  return reply.status.sessions.map((s) => s.cwd).filter((c): c is string => !!c);
}

function categories(staleWorktrees: Worktree[]): Category[] {
  const home = userHome();
  const derived = join(home, "Library/Developer/Xcode/DerivedData");
  return [
    {
      id: "worktree-build-output",
      title: "Build output in idle worktrees",
      note: "only git-ignored dirs (node_modules, bin, obj, .next, ...); reinstall/rebuild brings them back",
      scan() {
        const targets = staleWorktrees.flatMap((w) => ignoredBuildDirs(w.path));
        return {
          bytes: targets.reduce((s, t) => s + duBytes(t), 0),
          detail: `${targets.length} dirs in ${staleWorktrees.length} worktrees`,
          targets,
        };
      },
      apply(targets) {
        for (const t of targets) rmSync(t, { recursive: true, force: true });
      },
    },
    {
      id: "pnpm-store",
      title: "pnpm store, unreferenced packages",
      upTo: true,
      note: "prune frees only packages no project references",
      scan: () => (resolveReal("pnpm") ? { bytes: duBytes(join(home, "Library/pnpm/store")) } : null),
      apply: () => runTool("pnpm", ["store", "prune"]),
    },
    {
      id: "npm-cache",
      title: "npm cache",
      scan: () => (resolveReal("npm") ? { bytes: duBytes(join(home, ".npm/_cacache")) } : null),
      apply: () => runTool("npm", ["cache", "clean", "--force"]),
    },
    {
      id: "nuget-http-cache",
      title: "NuGet HTTP cache",
      scan: () => (resolveReal("dotnet") ? { bytes: duBytes(join(home, ".local/share/NuGet/http-cache")) } : null),
      apply: () => runTool("dotnet", ["nuget", "locals", "http-cache", "--clear"]),
    },
    {
      id: "nuget-packages",
      title: "NuGet global packages",
      optIn: true,
      note: "every project re-downloads its packages on next restore",
      scan: () => (resolveReal("dotnet") ? { bytes: duBytes(join(home, ".nuget/packages")) } : null),
      apply: () => runTool("dotnet", ["nuget", "locals", "global-packages", "--clear"]),
    },
    {
      id: "xcode-derived-data",
      title: "Xcode DerivedData",
      scan: () => (existsSync(derived) ? { bytes: duBytes(derived) } : null),
      apply() {
        for (const e of readdirSync(derived)) rmSync(join(derived, e), { recursive: true, force: true });
      },
    },
    {
      id: "simulators",
      title: "Unavailable iOS simulators",
      scan: () => (existsSync("/usr/bin/xcrun") ? { bytes: 0, detail: "xcrun simctl delete unavailable" } : null),
      apply: () => runTool("xcrun", ["simctl", "delete", "unavailable"]),
    },
    {
      id: "bouncer-logs",
      title: "Bouncer scheduled-job logs older than 14 days",
      scan() {
        if (!existsSync(paths.jobLogs)) return null;
        const cutoff = Date.now() - 14 * 86_400_000;
        const targets = readdirSync(paths.jobLogs)
          .map((f) => join(paths.jobLogs, f))
          .filter((f) => statSync(f).mtimeMs < cutoff);
        return { bytes: targets.reduce((s, t) => s + statSync(t).size, 0), targets };
      },
      apply(targets) {
        for (const t of targets) rmSync(t, { force: true });
      },
    },
  ];
}

export async function cleanCommand(args: string[]): Promise<void> {
  const policy = loadPolicy();
  const apply = args.includes("--apply");
  const wanted = args.filter((a) => !a.startsWith("--"));
  const now = Date.now();

  process.stderr.write(dim("Scanning caches and worktrees…\n"));
  const sessionDirs = await activeSessionDirs();
  const worktrees = findWorktrees(policy.janitor.roots);
  const staleMs = policy.janitor.staleDays * 86_400_000;
  const inUse = (w: Worktree) => sessionDirs.some((d) => d === w.path || d.startsWith(`${w.path}/`));
  const stale = worktrees.filter((w) => now - w.lastActivity >= staleMs && !inUse(w));

  const results: { cat: Category; bytes: number; detail?: string; targets?: string[] }[] = [];
  for (const cat of categories(stale)) {
    try {
      const r = cat.scan();
      if (r) results.push({ cat, ...r });
    } catch (e) {
      process.stderr.write(dim(`  ${cat.id} skipped: ${(e as Error).message}\n`));
    }
  }

  const worth = results.filter((r) => r.bytes >= 1024 ** 2);
  const empty = results.filter((r) => !worth.includes(r));
  const sure = worth.filter((r) => !r.cat.upTo && !r.cat.optIn).reduce((s, r) => s + r.bytes, 0);
  console.log(
    `\n${bold("Safe to clean")}  ${out.green(gb(sure))}${worth.some((r) => r.cat.upTo || r.cat.optIn) ? dim("  plus the up-to and opt-in items") : ""}`,
  );
  for (const r of worth) {
    const amount = `${r.cat.upTo ? "≤ " : ""}${gb(r.bytes)}`;
    const tag = r.cat.optIn ? yellow("  opt-in") : "";
    console.log(`  ${amount.padStart(10)}  ${r.cat.id.padEnd(22)} ${r.cat.title}${tag}`);
    const detail = [r.detail, r.cat.note].filter(Boolean).join(" · ");
    if (detail) console.log(`  ${"".padStart(10)}  ${"".padEnd(22)} ${dim(detail)}`);
  }
  if (!worth.length) console.log(dim("  Nothing worth cleaning."));
  if (empty.length) console.log(dim(`  already clean: ${empty.map((r) => r.cat.id).join(", ")}`));

  // Report-only: whole worktrees. Removing one is a human call (uncommitted work, local files).
  const sized = stale
    .map((w) => ({ ...w, bytes: duBytes(w.path) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);
  if (sized.length) {
    const n = stale.length;
    console.log(
      `\n${bold("Your call")}  ${dim(`${n} worktree${n === 1 ? "" : "s"} untouched for ${policy.janitor.staleDays}+ days, largest first. Bouncer never removes these.`)}`,
    );
    for (const w of sized) {
      const age = w.lastActivity ? `${Math.round((now - w.lastActivity) / 86_400_000)}d` : "?";
      const lines = porcelain(w.path);
      const pretty = w.path.replace(userHome(), "~");
      const state =
        lines === null
          ? yellow("git can't read it")
          : lines.length
            ? yellow(`${lines.length} uncommitted/untracked`)
            : out.green("clean");
      console.log(`  ${gb(w.bytes).padStart(10)}  ${age.padStart(4)}  ${pretty}  ${state}`);
      const indent = " ".repeat(20);
      const big = lines?.length ? largestUntracked(w.path, lines) : null;
      if (big) console.log(`${indent}${dim(`${gb(big.bytes)} of it is untracked ${big.path}`)}`);
      if (lines === null)
        console.log(`${indent}${dim("gitdir missing? `git worktree prune` in the main repo clears dangling entries")}`);
      else if (!lines.length) console.log(`${indent}${dim(`git -C ${pretty} worktree remove .`)}`);
    }
  }

  if (!apply) {
    console.log(dim("\nDry run, nothing deleted. To clean, name the ids: bouncer clean --apply <id> … (or all)"));
    return;
  }
  const chosen = results.filter((r) => (wanted.includes("all") ? !r.cat.optIn : wanted.includes(r.cat.id)));
  if (!chosen.length) {
    console.error(
      `\nbouncer: name what to clean, e.g. ${bold("--apply pnpm-store npm-cache")} or ${bold("--apply all")}`,
    );
    process.exit(2);
  }
  console.log();
  for (const r of chosen) {
    try {
      r.cat.apply(r.targets ?? []);
      console.log(`${mark.ok()} ${r.cat.id}`);
    } catch (e) {
      console.log(`${mark.fail()} ${r.cat.id}  ${dim((e as Error).message)}`);
    }
  }
}
