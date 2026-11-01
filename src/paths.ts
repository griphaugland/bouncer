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

export const LAUNCHD_LABEL = "com.bouncer.daemon";
