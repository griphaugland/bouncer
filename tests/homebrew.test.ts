import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homebrewInstall, homebrewSource } from "../src/install";

// Found on a real upgrade: Bouncer installed from a release, then `brew install`ed. `bouncer` on
// PATH still resolved to the old copy in ~/.bouncer/bin, so setup ran from that copy, kept it,
// and never recorded Homebrew's binary; `brew upgrade` could never reach the daemon.

const root = mkdtempSync(join(tmpdir(), "bouncer-brew-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function prefix(name: string, withBouncer: boolean): string {
  const p = join(root, name);
  mkdirSync(join(p, "opt/bouncer/bin"), { recursive: true });
  if (withBouncer) {
    writeFileSync(join(p, "opt/bouncer/bin/bouncer"), "#!/bin/sh\n");
    chmodSync(join(p, "opt/bouncer/bin/bouncer"), 0o755);
  }
  return p;
}

test("homebrewInstall finds Bouncer under the first prefix that has it", () => {
  const empty = prefix("empty", false);
  const brew = prefix("brew", true);
  expect(homebrewInstall([undefined, empty, brew])).toBe(join(brew, "opt/bouncer/bin/bouncer"));
  expect(homebrewInstall([empty])).toBeNull();
});

test("run from the installed copy on a Mac with Homebrew's: adopt Homebrew's", () => {
  const brewBin = "/opt/homebrew/opt/bouncer/bin/bouncer";
  expect(homebrewSource("/Users/x/.bouncer/bouncer", "/Users/x/.bouncer/bouncer", () => brewBin)).toBe(brewBin);
});

test("run from the installed copy without Homebrew: nothing to follow", () => {
  expect(homebrewSource("/Users/x/.bouncer/bouncer", "/Users/x/.bouncer/bouncer", () => null)).toBeNull();
});

test("run from a release or dev build: never adopt Homebrew's, the user chose this binary", () => {
  expect(
    homebrewSource("/tmp/release/bouncer", "/Users/x/.bouncer/bouncer", () => "/opt/homebrew/opt/bouncer/bin/bouncer"),
  ).toBeNull();
});
