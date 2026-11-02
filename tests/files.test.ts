import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, setBlock, writeAtomic } from "../src/files";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bouncer-files-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Review finding #1 (2026-11-02): a symlinked 0600 settings.json came back a plain 0644 file.
test("a symlinked config stays a symlink and its target is written", () => {
  const real = join(dir, "dotfiles-settings.json");
  const link = join(dir, "settings.json");
  writeFileSync(real, "{}");
  symlinkSync(real, link);
  writeAtomic(link, '{"a":1}');
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, "utf8")).toBe('{"a":1}');
});

test("permissions carry over", () => {
  const file = join(dir, "secret.json");
  writeFileSync(file, "{}", { mode: 0o600 });
  writeAtomic(file, '{"token":"x"}');
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("new files get 0644 and no temp file is left behind", () => {
  writeAtomic(join(dir, "new.md"), "x");
  expect(statSync(join(dir, "new.md")).mode & 0o777).toBe(0o644);
  expect(readdirSync(dir).filter((f) => f.includes("tmp-bouncer"))).toEqual([]);
});

test("backups never overwrite each other", () => {
  const file = join(dir, "rc");
  writeFileSync(file, "1");
  backup(file);
  writeFileSync(file, "2");
  backup(file);
  const backups = readdirSync(dir).filter((f) => f.includes(".bak-bouncer-"));
  expect(backups).toHaveLength(2);
  expect(backups.map((b) => readFileSync(join(dir, b), "utf8")).sort()).toEqual(["1", "2"]);
});

test("setBlock through a symlink edits the target", () => {
  const real = join(dir, "AGENTS.real.md");
  const link = join(dir, "AGENTS.md");
  writeFileSync(real, "mine\n");
  symlinkSync(real, link);
  setBlock(link, "<!-- s -->", "<!-- e -->", "note");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, "utf8")).toContain("note");
  setBlock(link, "<!-- s -->", "<!-- e -->", null);
  expect(readFileSync(real, "utf8")).toBe("mine\n");
});
