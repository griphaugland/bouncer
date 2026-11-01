// Wire protocol v1: newline-delimited JSON over a unix socket.
// A client connection that admitted a job IS the lease: if it closes, the job is released.

export const PROTOCOL_VERSION = 1;

export type Priority = "normal" | "high";
export type JobState = "queued" | "running" | "done" | "preempted" | "reaped" | "cancelled";
export type Load = "green" | "yellow" | "red";

export type ClientMsg =
  | { op: "admit"; slot: string; cmd: string; cwd: string; session: string; pid: number }
  | { op: "started"; job: number; childPid: number }
  | { op: "done"; job: number; exitCode: number }
  | { op: "requeue"; job: number }
  | { op: "probe"; slots: string[]; session: string }
  | { op: "prioritize"; session?: string; job?: number; clear?: boolean }
  | { op: "cancel"; job: number }
  | { op: "status" }
  | { op: "history"; limit: number };

export interface JobView {
  id: number;
  slot: string;
  session: string;
  cmd: string;
  cwd: string;
  priority: Priority;
  state: JobState;
  waitReason?: string;
  position?: number;
  elapsedMs: number;
  rssMb: number;
  preemptCount: number;
}

export interface StatusSnapshot {
  pid: number;
  startedAt: number;
  load: Load;
  pressureLevel: number;
  freePercent: number;
  swapUsedMb: number;
  swapTotalMb: number;
  maxConcurrent: number;
  slots: { name: string; capacity: number; used: number }[];
  running: JobView[];
  queued: JobView[];
  prioritized: { session: string; until: number }[];
  jetsamSinceStart: number;
  topProcesses: { name: string; count: number; rssMb: number }[];
}

export interface JobRecord {
  id: number;
  slot: string;
  session: string;
  cwd: string;
  cmd: string;
  priority: Priority;
  state: JobState;
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  peakRssMb: number;
  exitCode: number | null;
  preemptCount: number;
}

export type ServerMsg =
  | { type: "queued"; job: number; position: number; reason: string }
  | { type: "run"; job: number }
  | { type: "preempt"; job: number; by: number }
  | { type: "reap"; job: number; reason: string }
  | { type: "probe"; wouldRun: boolean; reason: string }
  | { type: "ok"; message?: string }
  | { type: "error"; message: string }
  | { type: "status"; status: StatusSnapshot }
  | { type: "history"; jobs: JobRecord[] };

export type Envelope<T> = T & { v: typeof PROTOCOL_VERSION };
