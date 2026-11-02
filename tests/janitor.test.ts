import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoredBuildDirs } from "../src/janitor";

const repo = mkdtempSync(join(tmpdir(), "bouncer-janitor-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

function git(...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", repo, "-c", "commit.gpgsign=false", ...args], { stdout: "ignore", stderr: "pipe" });
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

  const dirs = ignoredBuildDirs(repo).map((d) => d.slice(repo.length + 1)).sort();
  expect(dirs).toEqual(["node_modules", "src/Api/obj"]);
});
