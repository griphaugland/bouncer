import type { Policy } from "./policy";
import type { JobState, Load, Priority } from "./protocol";

export interface Job {
  id: number;
  slot: string;
  session: string;
  cwd: string;
  cmd: string;
  priority: Priority;
  state: JobState;
  /** Queue order. Requeued (preempted) jobs get a negative order, which puts them at the front. */
  order: number;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  childPid?: number;
  /** Set while Bouncer has asked the client to stop this job and is waiting for it to exit. */
  stopping?: "preempt" | "reap" | "cancel";
  stoppingSince?: number;
  peakRssMb: number;
  rssMb: number;
  preemptCount: number;
  exitCode?: number;
  waitReason?: string;
}

export type Action =
  | { type: "run"; job: Job }
  | { type: "preempt"; job: Job; by: Job }
  | { type: "reap"; job: Job; reason: string };

const TERMINAL: ReadonlySet<JobState> = new Set(["done", "reaped", "cancelled"]);

/**
 * Pure admission logic: no sockets, no clocks, no processes. Every decision Bouncer makes
 * about who runs, who waits and who gets stopped lives here, so it can be tested in isolation.
 */
export class Scheduler {
  readonly jobs = new Map<number, Job>();
  load: Load = "green";
  /**
   * Slots taken by heavy builds Bouncer did not start (IDE, unshimmed sessions). They count
   * against capacity but are never preempted or reaped: Bouncer has no lease on them.
   */
  external = new Map<string, number>();
  private prioritized = new Map<string, number>();
  private orderCounter = 0;
  private lastReapAt = Number.NEGATIVE_INFINITY;

  constructor(
    public policy: Policy,
    private nextId = 1,
  ) {}

  enqueue(input: { slot: string; session: string; cwd: string; cmd: string }, now: number): Job {
    const job: Job = {
      ...input,
      id: this.nextId++,
      priority: this.isPrioritized(input.session, now) ? "high" : "normal",
      state: "queued",
      order: ++this.orderCounter,
      queuedAt: now,
      peakRssMb: 0,
      rssMb: 0,
      preemptCount: 0,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  isPrioritized(session: string, now: number): boolean {
    const until = this.prioritized.get(session);
    if (until === undefined) return false;
    if (until <= now) {
      this.prioritized.delete(session);
      for (const j of this.active()) if (j.session === session) j.priority = "normal";
      return false;
    }
    return true;
  }

  prioritizeSession(session: string, now: number): void {
    this.prioritized.set(session, now + this.policy.priority.minutes * 60_000);
    for (const j of this.active()) if (j.session === session) j.priority = "high";
  }

  clearPriority(session: string): void {
    this.prioritized.delete(session);
    for (const j of this.active()) if (j.session === session) j.priority = "normal";
  }

  prioritizedSessions(now: number): { session: string; until: number }[] {
    for (const s of [...this.prioritized.keys()]) this.isPrioritized(s, now);
    return [...this.prioritized].map(([session, until]) => ({ session, until }));
  }

  active(): Job[] {
    return [...this.jobs.values()].filter((j) => !TERMINAL.has(j.state));
  }

  running(): Job[] {
    return [...this.jobs.values()].filter((j) => j.state === "running");
  }

  queued(): Job[] {
    return [...this.jobs.values()]
      .filter((j) => j.state === "queued")
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === "high" ? -1 : 1;
        return a.order - b.order;
      });
  }

  /** 1-based position among queued jobs competing for the same slot. */
  position(job: Job): number {
    return this.queued().filter((j) => j.slot === job.slot).indexOf(job) + 1;
  }

  capacity(slot: string): number {
    return this.policy.slots[slot] ?? 1;
  }

  markStarted(id: number, childPid: number): void {
    const job = this.jobs.get(id);
    if (job?.state === "running") job.childPid = childPid;
  }

  /** A preempted job's child has exited; put it back at the front of the queue. */
  requeue(id: number): Job | undefined {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.state)) return undefined;
    job.state = "queued";
    job.order = -++this.orderCounter;
    job.stopping = undefined;
    job.stoppingSince = undefined;
    job.startedAt = undefined;
    job.childPid = undefined;
    job.rssMb = 0;
    job.preemptCount++;
    return job;
  }

  /** The job ended. Its final state follows from why it ended. */
  finish(id: number, now: number, exitCode?: number, forced?: JobState): Job | undefined {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.state)) return undefined;
    job.state =
      forced ?? (job.stopping === "reap" ? "reaped" : job.stopping === "cancel" ? "cancelled" : "done");
    job.endedAt = now;
    job.exitCode = exitCode;
    job.stopping = undefined;
    this.jobs.delete(id);
    return job;
  }

  /** Ask a running or queued job to stop because the user cancelled it. */
  cancel(id: number, now: number): Job | undefined {
    const job = this.jobs.get(id);
    if (!job || TERMINAL.has(job.state)) return undefined;
    job.stopping = "cancel";
    job.stoppingSince = now;
    return job;
  }

  private blockReason(job: Job, bySlot: Map<string, number>, total: number): string | null {
    const high = job.priority === "high";
    if (this.load === "red") return "memory critical, nothing new starts";
    if (this.load === "yellow" && !high && total > 0) return "memory pressure elevated, one heavy job at a time";
    const cap = this.capacity(job.slot);
    const outside = this.external.get(job.slot) ?? 0;
    if ((bySlot.get(job.slot) ?? 0) + outside >= cap) {
      return `${job.slot} slot full (${cap}/${cap}${outside ? `, ${outside} outside Bouncer` : ""})`;
    }
    const outsideTotal = this.externalTotal();
    if (total + outsideTotal >= this.policy.maxConcurrent) {
      return `${total + outsideTotal} heavy jobs running (max ${this.policy.maxConcurrent})`;
    }
    return null;
  }

  externalTotal(): number {
    let n = 0;
    for (const v of this.external.values()) n += v;
    return n;
  }

  /** Would a new job for `slot` from `session` start right now? Used by the Claude Code hook. */
  wouldRunNow(slot: string, session: string, now: number): { wouldRun: boolean; reason: string } {
    const priority: Priority = this.isPrioritized(session, now) ? "high" : "normal";
    const ahead = this.queued().some((j) => j.slot === slot && (j.priority === "high" || priority === "normal"));
    if (ahead) return { wouldRun: false, reason: `${slot} has jobs waiting` };
    const { bySlot, total } = this.counts();
    const probe = { slot, priority } as Job;
    const reason = this.blockReason(probe, bySlot, total);
    return reason ? { wouldRun: false, reason } : { wouldRun: true, reason: "slot free" };
  }

  private counts(): { bySlot: Map<string, number>; total: number } {
    const bySlot = new Map<string, number>();
    const running = this.running();
    for (const j of running) bySlot.set(j.slot, (bySlot.get(j.slot) ?? 0) + 1);
    return { bySlot, total: running.length };
  }

  /** Admit what can run, preempt for high-priority work, reap when memory is critical. */
  tick(now: number): Action[] {
    const actions: Action[] = [];
    const running = this.running();
    const { bySlot } = this.counts();
    let total = running.length;

    for (const job of this.queued()) {
      if (job.stopping === "cancel") continue;
      const reason = this.blockReason(job, bySlot, total);
      if (!reason) {
        job.state = "running";
        job.startedAt = now;
        job.waitReason = undefined;
        bySlot.set(job.slot, (bySlot.get(job.slot) ?? 0) + 1);
        total++;
        actions.push({ type: "run", job });
        continue;
      }
      job.waitReason = reason;
      if (job.priority === "high" && this.load !== "red") {
        const victim = this.pickVictim(job, running, bySlot);
        if (victim) {
          victim.stopping = "preempt";
          victim.stoppingSince = now;
          actions.push({ type: "preempt", job: victim, by: job });
          job.waitReason = `stopping job ${victim.id} to make room`;
        }
      }
    }

    if (this.load === "red" && now - this.lastReapAt >= this.policy.reaper.cooldownSeconds * 1000) {
      const victim = newest(running.filter((j) => j.priority === "normal" && !j.stopping));
      if (victim) {
        victim.stopping = "reap";
        victim.stoppingSince = now;
        this.lastReapAt = now;
        actions.push({ type: "reap", job: victim, reason: "memory critical" });
      }
    }
    return actions;
  }

  private pickVictim(job: Job, running: Job[], bySlot: Map<string, number>): Job | undefined {
    const slotFull = (bySlot.get(job.slot) ?? 0) + (this.external.get(job.slot) ?? 0) >= this.capacity(job.slot);
    const relevant = running.filter((r) => (slotFull ? r.slot === job.slot : true));
    // Something is already being stopped to make this room; wait for it instead of killing more.
    if (relevant.some((r) => r.stopping === "preempt")) return undefined;
    return newest(relevant.filter((r) => r.priority === "normal" && !r.stopping));
  }
}

function newest(jobs: Job[]): Job | undefined {
  return jobs.reduce<Job | undefined>((acc, j) => (!acc || (j.startedAt ?? 0) > (acc.startedAt ?? 0) ? j : acc), undefined);
}
