// Deferred jobs: "run this at 02:00", "in 30 minutes", "whenever the machine is idle".
// Pure helpers only; the daemon owns storage and launching.

/** Env kept for a scheduled job. Never the full environment: it would persist tokens to disk. */
export const SCHEDULE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "CLAUDE_CODE_SESSION_ID",
  "CMUX_PANEL_ID",
  "BOUNCER_SESSION",
] as const;

export function pickEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SCHEDULE_ENV_KEYS) if (env[k] !== undefined) out[k] = env[k]!;
  return out;
}

/** `02:00` → the next 02:00 (today if still ahead, otherwise tomorrow), local time. */
export function nextClockTime(hhmm: string, now: Date): number {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`expected HH:MM, got "${hhmm}"`);
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) throw new Error(`not a time of day: "${hhmm}"`);
  const t = new Date(now);
  t.setHours(h, min, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/** `30m`, `2h`, `90s`, `1h30m` → milliseconds. */
export function parseDelay(text: string): number {
  const re = /(\d+)\s*([hms])/g;
  let total = 0;
  let consumed = "";
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : n * 1000;
    consumed += m[0];
  }
  if (!total || consumed.replace(/\s/g, "") !== text.replace(/\s/g, "")) {
    throw new Error(`expected a delay like 30m, 2h or 1h30m, got "${text}"`);
  }
  return total;
}

export interface ScheduledState {
  at: number | null;
  whenIdle: boolean;
}

export interface MachineState {
  now: number;
  idle: boolean;
}

/** A scheduled job starts once its time has come and, if asked, the machine is idle. */
export function isDue(job: ScheduledState, m: MachineState): boolean {
  if (job.at !== null && job.at > m.now) return false;
  if (job.whenIdle && !m.idle) return false;
  return true;
}
