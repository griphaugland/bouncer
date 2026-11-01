import { Database } from "bun:sqlite";
import type { JobRecord } from "./protocol";
import type { Job } from "./scheduler";

/** Finished-job history. Live state is in memory: a job's lease dies with its client anyway. */
export class Store {
  private db: Database;

  constructor(file: string) {
    this.db = new Database(file, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY,
      slot TEXT NOT NULL,
      session TEXT NOT NULL,
      cwd TEXT NOT NULL,
      cmd TEXT NOT NULL,
      priority TEXT NOT NULL,
      state TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      peak_rss_mb INTEGER NOT NULL,
      exit_code INTEGER,
      preempt_count INTEGER NOT NULL
    )`);
  }

  maxId(): number {
    const row = this.db.query("SELECT MAX(id) AS id FROM jobs").get() as { id: number | null };
    return row.id ?? 0;
  }

  save(job: Job): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO jobs VALUES ($id, $slot, $session, $cwd, $cmd, $priority, $state,
          $queuedAt, $startedAt, $endedAt, $peak, $exit, $preempts)`,
      )
      .run({
        $id: job.id,
        $slot: job.slot,
        $session: job.session,
        $cwd: job.cwd,
        $cmd: job.cmd,
        $priority: job.priority,
        $state: job.state,
        $queuedAt: job.queuedAt,
        $startedAt: job.startedAt ?? null,
        $endedAt: job.endedAt ?? null,
        $peak: Math.round(job.peakRssMb),
        $exit: job.exitCode ?? null,
        $preempts: job.preemptCount,
      });
  }

  recent(limit: number): JobRecord[] {
    return this.db
      .query(
        `SELECT id, slot, session, cwd, cmd, priority, state, queued_at AS queuedAt, started_at AS startedAt,
          ended_at AS endedAt, peak_rss_mb AS peakRssMb, exit_code AS exitCode, preempt_count AS preemptCount
         FROM jobs ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as JobRecord[];
  }
}
