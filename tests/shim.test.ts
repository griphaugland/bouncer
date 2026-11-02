import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shimScript } from "../src/install";
import { paths } from "../src/paths";
import { resolveReal } from "../src/run";

// Review finding #7: if PATH spells the shim folder differently (trailing slash, double slash,
// a symlink to it), the shim used to find itself as "the real tool" and exec itself forever.

let root: string;
let realBin: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bouncer-shim-"));
  realBin = join(root, "realbin");
  mkdirSync(realBin);
  writeFileSync(join(realBin, "faketool"), '#!/bin/sh\necho "real-tool $*"\n');
  chmodSync(join(realBin, "faketool"), 0o755);
  mkdirSync(paths.shimDir, { recursive: true });
  writeFileSync(join(paths.shimDir, "faketool"), shimScript("faketool"));
  chmodSync(join(paths.shimDir, "faketool"), 0o755);
  symlinkSync(paths.shimDir, join(root, "link-to-shims"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(paths.shimDir, "faketool"), { force: true });
});

const spellings = () => [`${paths.shimDir}/`, paths.shimDir.replace("/bin", "//bin"), join(root, "link-to-shims")];

test.each([0, 1, 2])("the shim skips itself whichever way PATH spells its folder (%d)", (i) => {
  const r = Bun.spawnSync([join(paths.shimDir, "faketool"), "hi"], {
    env: { ...process.env, PATH: `${spellings()[i]}:${realBin}:/usr/bin:/bin`, BOUNCER_BYPASS: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  expect(r.stdout.toString().trim()).toBe("real-tool hi");
});

test("a loop is cut off by the depth guard instead of running forever", () => {
  const r = Bun.spawnSync([join(paths.shimDir, "faketool")], {
    env: { ...process.env, PATH: "/usr/bin:/bin", BOUNCER_BYPASS: "1", BOUNCER_SHIM_DEPTH: "4" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  expect(r.exitCode).toBe(126);
  expect(r.stderr.toString()).toContain("shim loop");
});

test.each([0, 1, 2])("resolveReal skips the shim folder however PATH spells it (%d)", (i) => {
  const saved = process.env.PATH;
  process.env.PATH = `${spellings()[i]}:${realBin}`;
  try {
    expect(resolveReal("faketool")).toBe(join(realBin, "faketool"));
  } finally {
    process.env.PATH = saved;
  }
});
