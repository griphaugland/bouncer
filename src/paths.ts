import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// BOUNCER_HOME lets tests (and a future multi-user install) run fully isolated.
const home = process.env.BOUNCER_HOME ?? join(homedir(), ".bouncer");

export const paths = {
  home,
  socket: join(home, "bouncer.sock"),
  db: join(home, "jobs.db"),
  policy: join(home, "policy.yaml"),
  shimDir: join(home, "bin"),
  binary: join(home, "bouncer"),
  log: join(home, "daemon.log"),
  jobLogs: join(home, "logs"),
};

/** The account's real home from the user database. Unlike os.homedir(), ignores $HOME. */
function accountHome(): string {
  const entry = Bun.spawnSync(["/usr/bin/id", "-P"], { stdout: "pipe", stderr: "ignore" }).stdout.toString();
  return entry.trim().split(":")[8] || homedir();
}

let label: string | undefined;

/**
 * launchd job name. An install anywhere but the account's real ~/.bouncer (BOUNCER_HOME, or a
 * fake $HOME in a fresh-install test) gets its own job, so it can never replace the real daemon.
 */
export function launchdLabel(): string {
  label ??=
    home === join(accountHome(), ".bouncer")
      ? "com.bouncer.daemon"
      : `com.bouncer.daemon.${createHash("sha256").update(home).digest("hex").slice(0, 8)}`;
  return label;
}
