import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Socket } from "bun";
import { Conn } from "./conn";
import { takeLines } from "./lines";
import { advise, agentSessions, type ExternalJob, externalJobs } from "./observe";
import { paths } from "./paths";
import { compilerServers, descendants, getPlatform, killTree, type LoadSample, type Proc } from "./platform";
import { DEFAULT_POLICY, loadPolicy, type Policy } from "./policy";
import {
  type ClientMsg,
  type JobView,
  type Load,
  PROTOCOL_VERSION,
  type ScheduledRecord,
  type ServerMsg,
  type StatusSnapshot,
} from "./protocol";
import { redact } from "./redact";
import { isDue } from "./schedule";
import { type Action, type Job, Scheduler } from "./scheduler";
import { Store } from "./store";
import { VERSION } from "./version";

interface SockData {
  buf: string;
  decoder: TextDecoder;
  jobId?: number;
}

const SAMPLE_MS = 2000;
const PROCESS_SAMPLE_EVERY = 2; // every 2nd load sample
const OOM_CHECK_MS = 30_000;
const NOTIFY_COOLDOWN_MS = 5 * 60_000;
const CWD_REFRESH_MS = 60_000;
const IDLE_ADVICE_SEC = 60 * 60;
/** A session burning less than this share of one core counts as idle. */
const IDLE_CPU_SHARE = 0.01;
const IDLE_WINDOW_SEC = 60;

const isBouncerProcess = (command: string) =>
  command.startsWith(paths.binary) || /\/(\.bouncer|dist)\/bouncer\s+(shim|run)\b/.test(command);

const LOG_MAX_BYTES = 5 * 1024 * 1024;
const HISTORY_DAYS = 30;

/** Appends to daemon.log, rotating to daemon.log.1 at 5 MB so the log can never fill the disk. */
function log(line: string): void {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try {
    if (existsSync(paths.log) && statSync(paths.log).size > LOG_MAX_BYTES) renameSync(paths.log, `${paths.log}.1`);
    appendFileSync(paths.log, entry, { mode: 0o600 });
  } catch {
    process.stdout.write(entry);
  }
}

/**
 * Everything under ~/.bouncer is owner-only. The socket accepts commands that run as this user
 * (scheduled jobs), and logs hold command lines, so no other local account may read or connect.
 */
function lockDown(): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  chmodSync(paths.home, 0o700);
  for (const f of [paths.db, paths.log, `${paths.log}.1`, paths.policy]) {
    if (existsSync(f)) chmodSync(f, 0o600);
  }
  if (existsSync(paths.jobLogs)) chmodSync(paths.jobLogs, 0o700);
}

// Integration tests pin the load so they don't depend on how busy the test machine is.
const LOAD_OVERRIDE = process.env.BOUNCER_LOAD_OVERRIDE as Load | undefined;

export function classifyLoad(sample: LoadSample, policy: Policy): Load {
  if (LOAD_OVERRIDE === "green" || LOAD_OVERRIDE === "yellow" || LOAD_OVERRIDE === "red") return LOAD_OVERRIDE;
  if (sample.pressureLevel >= 4 || sample.freePercent < policy.gate.redFreePercent) return "red";
  if (sample.pressureLevel >= 2 || sample.freePercent < policy.gate.yellowFreePercent) return "yellow";
  return "green";
}

function short(cmd: string, n = 60): string {
  return cmd.length > n ? `${cmd.slice(0, n - 1)}…` : cmd;
}

export async function runDaemon(): Promise<void> {
  lockDown();

  if (existsSync(paths.socket)) {
    const existing = await Conn.open(500);
    if (existing) {
      existing.close();
      console.error("bouncer: daemon already running");
      process.exit(0);
    }
    unlinkSync(paths.socket);
  }

  const platform = getPlatform();
  const store = new Store(paths.db);
  chmodSync(paths.db, 0o600);
  const pruned = store.prune(Date.now() - HISTORY_DAYS * 86_400_000);
  if (pruned) log(`pruned ${pruned} history rows older than ${HISTORY_DAYS} days`);
  // A broken policy.yaml must never take the daemon down: a crash loop would leave every build
  // unguarded (review finding #3). Run on the defaults and say so in `bouncer status`.
  let policyError: string | null = null;
  let policy: Policy;
  try {
    policy = loadPolicy();
  } catch (e) {
    policy = DEFAULT_POLICY;
    policyError = (e as Error).message;
    log(`policy.yaml is invalid, running on defaults: ${policyError}`);
  }
  let policyMtime = existsSync(paths.policy) ? statSync(paths.policy).mtimeMs : 0;
  const sched = new Scheduler(policy, store.maxId() + 1);
  const startedAt = Date.now();

  const sockets = new Map<number, Socket<SockData>>();
  const lastSent = new Map<number, string>();
  let sample: LoadSample = platform.sampleLoad();
  sched.load = classifyLoad(sample, policy);
  let procs: Proc[] = [];
  let topProcesses: StatusSnapshot["topProcesses"] = [];
  let oomEvents = 0;
  let lastOomCheck = 0;
  let lastNotify = 0;
  let dotnetIdleSince: number | null = Date.now();
  let sampleCount = 0;
  let external: ExternalJob[] = [];
  let sessions: StatusSnapshot["sessions"] = [];
  let advice: string[] = [];
  let compilerServerMb = 0;
  let diskFreeGb = Number.POSITIVE_INFINITY;
  // Per session pid: CPU seen at the last sample and when it was last busy.
  const activity = new Map<number, { cpuSec: number; at: number; activeAt: number }>();
  let cwds = new Map<number, string>();
  let lastCwdRefresh = 0;
  const reportedExternal = new Set<number>();

  const send = (s: Socket<SockData> | undefined, msg: ServerMsg) => {
    s?.write(`${JSON.stringify({ ...msg, v: PROTOCOL_VERSION })}\n`);
  };

  const notify = (message: string) => {
    if (!policy.notifications || Date.now() - lastNotify < NOTIFY_COOLDOWN_MS) return;
    lastNotify = Date.now();
    platform.notify("Bouncer", message);
  };

  const finish = (job: Job, exitCode?: number, forced?: Job["state"]) => {
    const done = sched.finish(job.id, Date.now(), exitCode, forced);
    if (!done) return;
    sockets.delete(done.id);
    lastSent.delete(done.id);
    store.save(done);
    const secs = done.startedAt ? Math.round((done.endedAt! - done.startedAt) / 1000) : 0;
    log(
      `job ${done.id} ${done.state} exit=${exitCode ?? "-"} ${secs}s peak=${Math.round(done.peakRssMb)}MB ${short(done.cmd)}`,
    );
  };

  const dispatch = (actions: Action[]) => {
    for (const a of actions) {
      const s = sockets.get(a.job.id);
      if (!s) {
        finish(a.job, undefined, "cancelled");
        continue;
      }
      if (a.type === "run") {
        log(
          `job ${a.job.id} run [${a.job.slot}] ${a.job.priority} waited=${Math.round((Date.now() - a.job.queuedAt) / 1000)}s`,
        );
        send(s, { type: "run", job: a.job.id });
      } else if (a.type === "preempt") {
        log(`job ${a.job.id} preempted for job ${a.by.id}`);
        send(s, { type: "preempt", job: a.job.id, by: a.by.id });
      } else {
        log(`job ${a.job.id} reaped: ${a.reason}`);
        send(s, { type: "reap", job: a.job.id, reason: a.reason });
        notify(`Memory critical. Stopped job ${a.job.id}: ${short(a.job.cmd, 40)}`);
      }
    }
  };

  const schedule = () => {
    dispatch(sched.tick(Date.now()));
    for (const job of sched.queued()) {
      const position = sched.position(job);
      const reason = job.waitReason ?? "waiting";
      const key = `${position}|${reason}`;
      if (lastSent.get(job.id) === key) continue;
      lastSent.set(job.id, key);
      send(sockets.get(job.id), { type: "queued", job: job.id, position, reason });
    }
  };

  const view = (job: Job, now: number): JobView => ({
    id: job.id,
    slot: job.slot,
    session: job.session,
    cmd: job.cmd,
    cwd: job.cwd,
    priority: job.priority,
    state: job.state,
    waitReason: job.waitReason,
    position: job.state === "queued" ? sched.position(job) : undefined,
    elapsedMs: now - (job.state === "running" ? (job.startedAt ?? now) : job.queuedAt),
    rssMb: Math.round(job.rssMb),
    preemptCount: job.preemptCount,
  });

  const snapshot = (): StatusSnapshot => {
    const now = Date.now();
    const running = sched.running();
    const slotNames = new Set([...Object.keys(policy.slots), ...running.map((j) => j.slot)]);
    return {
      version: VERSION,
      pid: process.pid,
      startedAt,
      load: sched.load,
      pressureLevel: sample.pressureLevel,
      freePercent: sample.freePercent,
      swapUsedMb: Math.round(sample.swapUsedMb),
      swapTotalMb: Math.round(sample.swapTotalMb),
      maxConcurrent: policy.maxConcurrent,
      slots: [...slotNames].map((name) => ({
        name,
        capacity: sched.capacity(name),
        used: running.filter((j) => j.slot === name).length,
      })),
      running: running.map((j) => view(j, now)),
      queued: sched.queued().map((j) => view(j, now)),
      prioritized: sched.prioritizedSessions(now),
      jetsamSinceStart: oomEvents,
      topProcesses,
      external,
      sessions,
      advice: policyError
        ? [`policy.yaml is invalid (${policyError}). Running on the defaults until it's fixed.`, ...advice]
        : advice,
      diskFreeGb: Number.isFinite(diskFreeGb) ? Math.round(diskFreeGb) : -1,
    };
  };

  const observe = (now: number) => {
    external = externalJobs(procs, isBouncerProcess, policy.tools).map((e) => ({ ...e, command: redact(e.command) }));
    const counts = new Map<string, number>();
    for (const e of external) counts.set(e.slot, (counts.get(e.slot) ?? 0) + 1);
    sched.external = policy.countOutsideBuilds ? counts : new Map();
    for (const e of external) {
      if (reportedExternal.has(e.pid)) continue;
      reportedExternal.add(e.pid);
      log(`outside Bouncer: pid=${e.pid} [${e.slot}] ${short(redact(e.command), 80)}`);
    }
    const livePids = new Set(procs.map((p) => p.pid));
    for (const pid of reportedExternal) if (!livePids.has(pid)) reportedExternal.delete(pid);

    const found = agentSessions(procs);
    if (now - lastCwdRefresh > CWD_REFRESH_MS) {
      lastCwdRefresh = now;
      try {
        cwds = platform.cwdOf(found.map((s) => s.pid));
      } catch {}
    }
    sessions = found.map((s) => {
      // Judge activity over 60 s windows: short windows turn every timer tick into "active".
      // A session first seen now has unknown history, so it counts as active until proven idle.
      const prev = activity.get(s.pid) ?? { cpuSec: s.cpuSec, at: now, activeAt: now };
      const wallSec = (now - prev.at) / 1000;
      if (wallSec >= IDLE_WINDOW_SEC) {
        if ((s.cpuSec - prev.cpuSec) / wallSec > IDLE_CPU_SHARE) prev.activeAt = now;
        prev.cpuSec = s.cpuSec;
        prev.at = now;
      }
      activity.set(s.pid, prev);
      const activeAt = prev.activeAt;
      return {
        pid: s.pid,
        kind: s.kind,
        sessionId: s.sessionId,
        cwd: cwds.get(s.pid),
        rssMb: s.rssMb,
        elapsedSec: s.elapsedSec,
        idleSec: Math.round((now - activeAt) / 1000),
      };
    });
    for (const pid of activity.keys()) if (!livePids.has(pid)) activity.delete(pid);
    sessions.sort((a, b) => b.rssMb - a.rssMb);

    compilerServerMb = compilerServers(procs).reduce((s, p) => s + p.rssKb, 0) / 1024;
    try {
      diskFreeGb = platform.diskFreeGb();
    } catch {}
    advice = advise({
      sessions,
      external,
      compilerServerMb,
      freePercent: sample.freePercent,
      idleThresholdSec: IDLE_ADVICE_SEC,
      diskFreeGb,
      minFreeDiskGb: policy.janitor.minFreeDiskGb,
    });
  };

  const handle = (s: Socket<SockData>, msg: ClientMsg & { v?: number }) => {
    if (msg.v !== PROTOCOL_VERSION) {
      send(s, { type: "error", message: `unsupported protocol version ${msg.v}` });
      return;
    }
    const now = Date.now();
    switch (msg.op) {
      case "admit": {
        const job = sched.enqueue(
          { slot: msg.slot, session: msg.session, cwd: msg.cwd, cmd: redact(msg.cmd), preemptible: msg.preemptible },
          now,
        );
        s.data.jobId = job.id;
        sockets.set(job.id, s);
        log(`job ${job.id} queued [${job.slot}] ${job.priority} ${short(job.cmd)}`);
        schedule();
        break;
      }
      case "started":
        sched.markStarted(msg.job, msg.childPid);
        break;
      case "done": {
        const job = sched.jobs.get(msg.job);
        if (job) finish(job, msg.exitCode);
        schedule();
        break;
      }
      case "requeue": {
        const job = sched.requeue(msg.job);
        if (job) log(`job ${job.id} requeued at the front (preempted ${job.preemptCount}x)`);
        schedule();
        break;
      }
      case "probe": {
        const results = msg.slots.map((slot) => sched.wouldRunNow(slot, msg.session, now));
        const blocked = results.find((r) => !r.wouldRun);
        send(s, { type: "probe", wouldRun: !blocked, reason: blocked?.reason ?? "slot free" });
        break;
      }
      case "prioritize": {
        let session = msg.session;
        if (msg.job !== undefined) session = sched.jobs.get(msg.job)?.session;
        if (!session && !msg.cwd) {
          send(s, { type: "error", message: "no such job or session" });
          break;
        }
        if (msg.clear) sched.clearPriority(session ?? "", msg.cwd);
        else {
          if (session) sched.prioritizeSession(session, now);
          if (msg.cwd) sched.prioritizeCwd(msg.cwd, now);
        }
        log(
          `${[session && `session ${session}`, msg.cwd && `folder ${msg.cwd}`].filter(Boolean).join(" + ")} ${msg.clear ? "priority cleared" : "prioritized"}`,
        );
        send(s, {
          type: "ok",
          message: msg.clear ? "priority cleared" : `prioritized for ${policy.priority.minutes} min`,
        });
        schedule();
        break;
      }
      case "cancel": {
        const job = sched.cancel(msg.job, now);
        if (!job) {
          send(s, { type: "error", message: `no active job ${msg.job}` });
          break;
        }
        send(sockets.get(job.id), { type: "reap", job: job.id, reason: "cancelled from bouncer CLI" });
        if (job.state === "queued") finish(job, 130);
        send(s, { type: "ok", message: `cancelled job ${job.id}` });
        schedule();
        break;
      }
      case "status":
        send(s, { type: "status", status: snapshot() });
        break;
      case "history":
        send(s, { type: "history", jobs: store.recent(Math.min(Math.max(msg.limit, 1), 500)) });
        break;
      case "schedule": {
        if (!msg.argv.length) {
          send(s, { type: "error", message: "nothing to schedule" });
          break;
        }
        mkdirSync(paths.jobLogs, { recursive: true, mode: 0o700 });
        const rec = store.addScheduled({
          argv: msg.argv,
          cwd: msg.cwd,
          env: msg.env,
          session: msg.session,
          at: msg.at,
          whenIdle: msg.whenIdle,
          createdAt: now,
          logPath: join(paths.jobLogs, `scheduled-${now}-${Math.random().toString(36).slice(2, 8)}.log`),
        });
        log(
          `scheduled s${rec.id} at=${rec.at ? new Date(rec.at).toISOString() : "-"} idle=${rec.whenIdle} ${short(redact(rec.argv.join(" ")))}`,
        );
        send(s, { type: "ok", message: `s${rec.id}` });
        break;
      }
      case "scheduled": {
        const states: ScheduledRecord["state"][] = msg.all
          ? ["pending", "running", "done", "failed", "cancelled"]
          : ["pending", "running"];
        // Stored argv is what runs; what leaves the daemon is redacted.
        const items = store
          .scheduled(states)
          .map(({ env: _env, argv, ...rest }) => ({ ...rest, argv: [redact(argv.join(" "))] }));
        send(s, { type: "scheduled", items });
        break;
      }
      case "unschedule": {
        const rec = store.scheduled(["pending"]).find((r) => r.id === msg.id);
        if (!rec) {
          send(s, {
            type: "error",
            message: `no pending scheduled job s${msg.id} (running ones: bouncer cancel <job>)`,
          });
          break;
        }
        store.setScheduledState(rec.id, "cancelled", { endedAt: now });
        log(`scheduled s${rec.id} cancelled`);
        send(s, { type: "ok", message: `cancelled s${rec.id}` });
        break;
      }
    }
  };

  Bun.listen<SockData>({
    unix: paths.socket,
    socket: {
      open(s) {
        s.data = { buf: "", decoder: new TextDecoder() };
      },
      data(s, chunk) {
        const { lines, rest } = takeLines(s.data.buf + s.data.decoder.decode(chunk, { stream: true }));
        s.data.buf = rest;
        for (const line of lines) {
          try {
            handle(s, JSON.parse(line));
          } catch (e) {
            send(s, { type: "error", message: `bad message: ${(e as Error).message}` });
          }
        }
      },
      close(s) {
        // The connection was the lease. Its client is gone, so is its claim on a slot.
        const id = s.data?.jobId;
        const job = id === undefined ? undefined : sched.jobs.get(id);
        if (job) {
          finish(job, undefined, job.stopping === "reap" ? "reaped" : "cancelled");
          schedule();
        }
      },
      error(_s, e) {
        log(`socket error: ${e.message}`);
      },
    },
  });
  chmodSync(paths.socket, 0o600);

  // An upgrade (brew upgrade, or `bouncer install` of a new version) replaces the binary under a
  // running daemon. Restart onto it, but only once nothing is running: launchd brings us back.
  const binaryStamp = () => {
    try {
      const st = statSync(paths.binary);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };
  const startedStamp = binaryStamp();

  // Installed from Homebrew: ~/.bouncer/bouncer is a copy, so pull `brew upgrade`s in by hand.
  const source = existsSync(paths.source) ? readFileSync(paths.source, "utf8").trim() : null;
  const sourceStamp = () => {
    try {
      if (!source) return null;
      const st = statSync(source);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };
  const startedSource = sourceStamp();

  const sampleLoop = async () => {
    const now = Date.now();
    const src = startedSource && sourceStamp();
    if (src && src !== startedSource && sched.active().length === 0 && source) {
      try {
        copyFileSync(source, `${paths.binary}.new`);
        chmodSync(`${paths.binary}.new`, 0o755);
        renameSync(`${paths.binary}.new`, paths.binary);
        log("Homebrew upgraded Bouncer; copied the new binary");
      } catch (e) {
        log(`could not copy the upgraded binary from ${source}: ${(e as Error).message}`);
      }
    }
    const stamp = startedStamp && binaryStamp();
    if (stamp && stamp !== startedStamp && sched.active().length === 0) {
      log("binary was upgraded and nothing is running; restarting onto the new version");
      // Leave the socket file: clients that see it keep retrying through the restart instead of
      // failing open. The new daemon replaces it.
      process.exit(0);
    }
    try {
      if (existsSync(paths.policy)) {
        const m = statSync(paths.policy).mtimeMs;
        if (m !== policyMtime) {
          policyMtime = m;
          policy = loadPolicy();
          policyError = null;
          sched.policy = policy;
          log("policy reloaded");
        }
      }
    } catch (e) {
      const message = (e as Error).message;
      if (message !== policyError) log(`policy not reloaded, keeping the last good one: ${message}`);
      policyError = message;
    }

    try {
      sample = platform.sampleLoad();
    } catch (e) {
      log(`load sample failed: ${(e as Error).message}`);
    }
    const load = classifyLoad(sample, policy);
    if (load !== sched.load) {
      log(`load ${sched.load} -> ${load} (pressure=${sample.pressureLevel} free=${sample.freePercent}%)`);
      if (load === "red") notify(`Memory critical (${sample.freePercent}% free). Holding all new builds.`);
      sched.load = load;
    }

    if (sampleCount++ % PROCESS_SAMPLE_EVERY === 0) {
      try {
        procs = platform.listProcesses();
        observe(now);
        updateJobMemory(now);
        await reapCompilerServers(now);
        topProcesses = summarize(procs);
      } catch (e) {
        log(`process sample failed: ${(e as Error).message}`);
      }
    }

    // A client that ignores a stop request gets its job tree killed from here.
    for (const job of sched.running()) {
      if (job.stopping && job.childPid && now - (job.stoppingSince ?? now) > policy.reaper.stopGraceSeconds * 2000) {
        log(`job ${job.id} ignored stop request, killing pid ${job.childPid}`);
        void killTree(platform, job.childPid, 2000);
        job.stoppingSince = now;
      }
    }

    if (now - lastOomCheck > OOM_CHECK_MS) {
      lastOomCheck = now;
      const count = platform.oomEventsSince(startedAt);
      if (count > oomEvents) {
        log(`macOS Jetsam event detected (${count} since start). Thresholds may be too loose.`);
        notify("macOS killed processes for memory. Bouncer's thresholds may be too loose.");
      }
      oomEvents = count;
    }

    launchScheduled(now);
    schedule();
  };

  // Scheduled jobs are launched as `bouncer run -- <argv>`, so they queue like everything else.
  const launched = new Set<number>();
  for (const rec of store.scheduled(["running"])) {
    // A previous daemon was stopped while this ran; its outcome is unknown.
    store.setScheduledState(rec.id, "failed", { endedAt: Date.now() });
    log(`scheduled s${rec.id} was running when the daemon stopped; marked failed`);
  }

  const launchScheduled = (now: number) => {
    const pending = store.scheduled(["pending"]);
    if (!pending.length) return;
    const idle = sched.load === "green" && !sched.active().length && !external.length;
    for (const rec of pending.reverse()) {
      if (launched.has(rec.id) || !isDue(rec, { now, idle })) continue;
      launched.add(rec.id);
      store.setScheduledState(rec.id, "running", { startedAt: now });
      log(`scheduled s${rec.id} starting: ${short(redact(rec.argv.join(" ")))}`);
      let proc: ReturnType<typeof Bun.spawn>;
      let fd: number | undefined;
      try {
        fd = openSync(rec.logPath, "a", 0o600);
        proc = Bun.spawn([process.execPath, "run", "--", ...rec.argv], {
          cwd: rec.cwd,
          env: { ...rec.env, BOUNCER_SESSION: rec.session },
          stdin: "ignore",
          stdout: fd,
          stderr: fd,
        });
      } catch (e) {
        if (fd !== undefined) closeSync(fd);
        store.setScheduledState(rec.id, "failed", { endedAt: now });
        log(`scheduled s${rec.id} failed to start: ${(e as Error).message}`);
        continue;
      }
      const logFd = fd;
      void proc.exited.then((code) => {
        closeSync(logFd);
        const state = code === 0 ? "done" : "failed";
        store.setScheduledState(rec.id, state, { endedAt: Date.now(), exitCode: code });
        log(`scheduled s${rec.id} ${state} exit=${code}`);
        if (policy.notifications)
          platform.notify(
            "Bouncer",
            `Scheduled s${rec.id} ${code === 0 ? "finished" : `failed (exit ${code})`}: ${short(redact(rec.argv.join(" ")), 50)}`,
          );
      });
      // Idle-gated jobs go one at a time: the first one makes the machine busy anyway.
      if (rec.whenIdle) break;
    }
  };

  const updateJobMemory = (now: number) => {
    const servers = compilerServers(procs);
    const serverRssMb = servers.reduce((sum, p) => sum + p.rssKb, 0) / 1024;
    const dotnetJobs = sched.running().filter((j) => j.slot === "dotnet");
    for (const job of sched.running()) {
      if (!job.childPid) continue;
      const tree = descendants(procs, job.childPid);
      const self = procs.find((p) => p.pid === job.childPid);
      let mb = (tree.reduce((sum, p) => sum + p.rssKb, 0) + (self?.rssKb ?? 0)) / 1024;
      // Compiler servers are detached from the build that spawned them; charge them to dotnet jobs.
      if (job.slot === "dotnet" && dotnetJobs.length) mb += serverRssMb / dotnetJobs.length;
      job.rssMb = mb;
      job.peakRssMb = Math.max(job.peakRssMb, mb);
    }
    // A dotnet build outside Bouncer is using the compiler server too; never kill it mid-build.
    const dotnetBusy = dotnetJobs.length > 0 || external.some((e) => e.slot === "dotnet");
    dotnetIdleSince = dotnetBusy ? null : (dotnetIdleSince ?? now);
  };

  const reapCompilerServers = async (now: number) => {
    if (!policy.reaper.killCompilerServers || dotnetIdleSince === null) return;
    const idleFor = now - dotnetIdleSince;
    if (idleFor < policy.reaper.compilerServerIdleSeconds * 1000 && sched.load !== "red") return;
    for (const p of compilerServers(procs)) {
      log(`killing idle compiler server pid=${p.pid} rss=${Math.round(p.rssKb / 1024)}MB ${short(p.command, 80)}`);
      await killTree(platform, p.pid, 3000);
    }
  };

  // Killing a compiler server can take seconds; never let two samples overlap.
  let sampling = false;
  const tickSample = async () => {
    if (sampling) return;
    sampling = true;
    const started = performance.now();
    try {
      await sampleLoop();
    } finally {
      sampling = false;
      // The loop shares a thread with the socket; a slow pass delays every client. Surface it.
      const ms = Math.round(performance.now() - started);
      if (ms > 500) log(`slow sample: ${ms} ms`);
    }
  };
  // Sample immediately so the first `bouncer status` already shows memory users.
  void tickSample();
  setInterval(() => void tickSample(), SAMPLE_MS);

  const shutdown = () => {
    log("daemon stopping");
    try {
      unlinkSync(paths.socket);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  log(
    `daemon v${VERSION} started pid=${process.pid} load=${sched.load} pressure=${sample.pressureLevel} free=${sample.freePercent}%`,
  );
}

function appName(command: string): string {
  if (/\/claude\/versions\/|(^|\/)claude(\s|$)/.test(command)) return "claude";
  if (/(^|\/)codex(\s|$)|Codex\.app/.test(command)) return "codex";
  const app = command.match(/\/([^/]+)\.app\//);
  if (app) return app[1]!;
  return basename(command.split(/\s+/)[0] ?? command);
}

function summarize(procs: Proc[]): StatusSnapshot["topProcesses"] {
  const groups = new Map<string, { count: number; rssKb: number }>();
  for (const p of procs) {
    const name = appName(p.command);
    const g = groups.get(name) ?? { count: 0, rssKb: 0 };
    g.count++;
    g.rssKb += p.rssKb;
    groups.set(name, g);
  }
  return [...groups]
    .map(([name, g]) => ({ name, count: g.count, rssMb: Math.round(g.rssKb / 1024) }))
    .sort((a, b) => b.rssMb - a.rssMb)
    .slice(0, 8);
}
