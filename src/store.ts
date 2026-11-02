import { Database } from "bun:sqlite";
import type { JobRecord, ScheduledRecord } from "./protocol";
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

  private ensureScheduled(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS scheduled (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      argv TEXT NOT NULL,
      cwd TEXT NOT NULL,
      env TEXT NOT NULL,
      session TEXT NOT NULL,
      at INTEGER,
      when_idle INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      exit_code INTEGER,
      log_path TEXT NOT NULL
    )`);
  }

  addScheduled(s: Omit<ScheduledRecord, "id" | "state" | "startedAt" | "endedAt" | "exitCode">): ScheduledRecord {
    this.ensureScheduled();
    const row = this.db
      .query(
        `INSERT INTO scheduled (argv, cwd, env, session, at, when_idle, created_at, state, log_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id`,
      )
      .get(
        JSON.stringify(s.argv),
        s.cwd,
        JSON.stringify(s.env),
        s.session,
        s.at,
        s.whenIdle ? 1 : 0,
        s.createdAt,
        s.logPath,
      ) as {
      id: number;
    };
    return { ...s, id: row.id, state: "pending", startedAt: null, endedAt: null, exitCode: null };
  }

  scheduled(states: ScheduledRecord["state"][] = ["pending", "running"], limit = 100): ScheduledRecord[] {
    this.ensureScheduled();
    const placeholders = states.map(() => "?").join(",");
    const rows = this.db
      .query(`SELECT * FROM scheduled WHERE state IN (${placeholders}) ORDER BY id DESC LIMIT ?`)
      .all(...states, limit) as any[];
    return rows.map((r) => ({
      id: r.id,
      argv: JSON.parse(r.argv),
      cwd: r.cwd,
      env: JSON.parse(r.env),
      session: r.session,
      at: r.at,
      whenIdle: r.when_idle === 1,
      createdAt: r.created_at,
      state: r.state,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      exitCode: r.exit_code,
      logPath: r.log_path,
    }));
  }

  setScheduledState(
    id: number,
    state: ScheduledRecord["state"],
    fields: { startedAt?: number; endedAt?: number; exitCode?: number } = {},
  ): void {
    this.ensureScheduled();
    this.db
      .query(
        `UPDATE scheduled SET state = ?, started_at = COALESCE(?, started_at), ended_at = COALESCE(?, ended_at),
          exit_code = COALESCE(?, exit_code) WHERE id = ?`,
      )
      .run(state, fields.startedAt ?? null, fields.endedAt ?? null, fields.exitCode ?? null, id);
  }

  /** Drop finished history older than `before`. Returns the number of rows removed. */
  prune(before: number): number {
    this.ensureScheduled();
    const jobs = this.db.query("DELETE FROM jobs WHERE COALESCE(ended_at, queued_at) < ?").run(before).changes;
    const sched = this.db
      .query(
        "DELETE FROM scheduled WHERE state IN ('done','failed','cancelled') AND COALESCE(ended_at, created_at) < ?",
      )
      .run(before).changes;
    return jobs + sched;
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
