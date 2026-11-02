import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// Preloaded before every test file (bunfig.toml). The whole suite runs with HOME pointing at a
// throwaway directory, so no test can ever touch the real ~/.claude, ~/.codex, shell rc files or
// launchd jobs, even one that forgets to isolate itself. (Before this existed, tests that set
// HOME themselves still edited the real files: Bun caches os.homedir().)

const fakeHome = mkdtempSync(join(tmpdir(), "bouncer-test-home-"));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;
for (const v of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "BOUNCER_HOME", "BOUNCER_BYPASS", "BOUNCER_JOB", "BOUNCER_SESSION"]) {
  delete process.env[v];
}
// A fake home has no ~/.gitconfig.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: "bouncer-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "bouncer-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

const { userHome, paths } = await import("../src/paths");
if (userHome() !== fakeHome || paths.home.startsWith(realHome ?? "/nonexistent") || realHome === userInfo().homedir && userHome() === realHome) {
  console.error(`tests/setup.ts: refusing to run, home did not isolate (userHome=${userHome()})`);
  process.exit(1);
}

process.on("exit", () => rmSync(fakeHome, { recursive: true, force: true }));
