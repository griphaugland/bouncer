import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoredBuildDirs } from "../src/janitor";

const repo = mkdtempSync(join(tmpdir(), "bouncer-janitor-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", repo, "-c", "commit.gpgsign=false", ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

test("only directories git reports as ignored are cleanable", () => {
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\nobj/\n");
  mkdirSync(join(repo, "bin"));
  writeFileSync(join(repo, "bin", "tool"), "tracked script");
  git("add", "-A");
  git("commit", "-qm", "init");

  mkdirSync(join(repo, "node_modules", "x"), { recursive: true }); // ignored → cleanable
  mkdirSync(join(repo, "src", "Api", "obj"), { recursive: true }); // ignored, nested → cleanable
  mkdirSync(join(repo, "coverage")); // build-dir name but NOT ignored → must survive
  // bin/ is tracked → must survive

  const dirs = ignoredBuildDirs(repo)
    .map((d) => d.slice(repo.length + 1))
    .sort();
  expect(dirs).toEqual(["node_modules", "src/Api/obj"]);
});

import { findWorktrees, inUse } from "../src/janitor";

test("a worktree is in use when work happens inside it or above it (review #6)", () => {
  expect(inUse("/repo/wt", ["/repo/wt/web"])).toBe(true);
  expect(inUse("/repo/wt", ["/repo/wt"])).toBe(true);
  expect(inUse("/repo/sub", ["/repo"])).toBe(true);
  expect(inUse("/repo/wt", ["/repo/wt-2"])).toBe(false);
  expect(inUse("/repo/wt", [])).toBe(false);
});

test("git submodules are not mistaken for worktrees", () => {
  const root = mkdtempSync(join(tmpdir(), "bouncer-sub-"));
  mkdirSync(join(root, "app", ".git", "modules", "lib"), { recursive: true });
  mkdirSync(join(root, "app", "lib"), { recursive: true });
  writeFileSync(join(root, "app", "lib", ".git"), "gitdir: ../.git/modules/lib\n");
  mkdirSync(join(root, "repo.git", "worktrees", "feature"), { recursive: true });
  mkdirSync(join(root, "feature"));
  writeFileSync(join(root, "feature", ".git"), `gitdir: ${join(root, "repo.git", "worktrees", "feature")}\n`);
  const found = findWorktrees([root]).map((w) => w.path.slice(root.length + 1));
  rmSync(root, { recursive: true, force: true });
  expect(found).toEqual(["feature"]);
});
