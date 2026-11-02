import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json";

// Checks on the compiled binary itself (run `bun run build` first; CI does).
const BIN = join(import.meta.dir, "..", "dist", "bouncer");

describe.skipIf(!existsSync(BIN))("compiled binary", () => {
  // The shim runs inside users' projects. A compiled Bun binary autoloads .env by default, which
  // would inject the project's .env into every build it starts (found 2026-11-02).
  test("never loads a .env from the directory it runs in", () => {
    const dir = mkdtempSync(join(tmpdir(), "bouncer-env-"));
    writeFileSync(join(dir, ".env"), "LEAKED_FROM_DOTENV=yes\n");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a JS template
    const r = Bun.spawnSync([BIN, "run", "--", "sh", "-c", 'printf "%s" "${LEAKED_FROM_DOTENV:-unset}"'], {
      cwd: dir,
      env: { ...process.env, BOUNCER_BYPASS: "1", LEAKED_FROM_DOTENV: undefined },
      stdout: "pipe",
    });
    rmSync(dir, { recursive: true, force: true });
    expect(r.stdout.toString()).toBe("unset");
  });

  test("reports the package version", () => {
    expect(Bun.spawnSync([BIN, "--version"], { stdout: "pipe" }).stdout.toString().trim()).toBe(pkg.version);
  });
});
