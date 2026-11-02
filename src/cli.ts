import { ask } from "./conn";
import type { JobView, Load, StatusSnapshot } from "./protocol";
import { sessionId } from "./run";
import { nextClockTime, parseDelay, pickEnv } from "./schedule";
import { err, mark, out, padEnd, padStart, type Tone, tone, truncate, width } from "./term";
import { VERSION } from "./version";

const LOAD_TONE: Record<Load, Tone> = { green: "green", yellow: "yellow", red: "red" };
const LOAD_TITLE: Record<Load, string> = { green: "Clear", yellow: "Tight", red: "Holding the door" };
const PRESSURE: Record<number, string> = { 1: "normal", 2: "warn", 4: "critical" };

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

/** Coarse age for long-lived things: "5m", "4h13m", "3d". */
function age(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${Math.max(m, 0)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d`;
}

function size(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function notRunning(): never {
  console.error(
    `bouncer: the daemon isn't running. Start it with ${out.bold("bouncer install")}, or check ${out.bold("bouncer doctor")}.`,
  );
  process.exit(1);
}

async function fetchStatus(): Promise<StatusSnapshot> {
  const reply = await ask({ op: "status" });
  if (reply?.type !== "status") notRunning();
  if (reply.status.version !== VERSION) {
    process.stderr.write(
      `${err.yellow("!")} the running daemon is v${reply.status.version ?? "?"}, this CLI is v${VERSION}. Run ${err.bold("bouncer install")} to restart it.\n`,
    );
  }
  return reply.status;
}

function homeRel(path?: string): string {
  if (!path) return "";
  const home = process.env.HOME ?? "";
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function basenameOf(path?: string): string {
  return path ? (path.split("/").filter(Boolean).pop() ?? path) : "";
}

/** One line per job. Columns: id, slot, command (flexible), then right-aligned facts. */
function jobLine(j: JobView, cmdWidth: number): string[] {
  const prio = j.priority === "high" ? out.yellow("↑") : " ";
  const facts =
    j.state === "running"
      ? `${padStart(size(j.rssMb), 8)}  ${padStart(duration(j.elapsedMs), 6)}`
      : `${padStart(`#${j.position ?? "?"}`, 8)}  ${padStart(duration(j.elapsedMs), 6)}`;
  // Prefix is 10 columns wide for jobs and outside builds alike, so their columns line up.
  const lines = [
    `${prio} ${padStart(out.dim(String(j.id)), 6)}  ${padEnd(j.slot, 7)} ${padEnd(truncate(j.cmd, cmdWidth), cmdWidth)}${facts}`,
  ];
  if (j.state !== "running" && j.waitReason) lines.push(`${" ".repeat(18)}${out.dim(j.waitReason)}`);
  return lines;
}

function pips(used: number, outside: number, capacity: number): string {
  let s = "";
  for (let i = 0; i < Math.max(capacity, used + outside); i++) {
    s += i < used ? "●" : i < used + outside ? out.yellow("●") : out.dim("○");
  }
  return s;
}

/** Compact segment for a statusline: quiet when idle, specific when something waits or memory is tight. */
export function segment(st: StatusSnapshot): string {
  const dot = mark.dot(LOAD_TONE[st.load]);
  const parts: string[] = [];
  if (st.running.length) parts.push(`${st.running.length} running`);
  if (st.queued.length) parts.push(out.yellow(`${st.queued.length} waiting`));
  if (st.external.length) parts.push(out.yellow(`${st.external.length} outside`));
  if (st.load !== "green") parts.push(tone(LOAD_TONE[st.load], `${st.freePercent}% free`));
  return parts.length ? `${dot} bouncer ${parts.join(out.dim(" · "))}` : `${dot} bouncer`;
}

export function renderStatus(st: StatusSnapshot): string[] {
  const lines: string[] = [];
  const cmdWidth = Math.max(24, width() - 18 - 18);
  const section = (title: string, detail?: string) => {
    lines.push("", detail ? `${out.bold(title)}  ${out.dim(detail)}` : out.bold(title));
  };

  // Header: the state in words, then the numbers behind it.
  const pressure = PRESSURE[st.pressureLevel] ?? String(st.pressureLevel);
  const facts = [
    `${st.freePercent}% free`,
    `pressure ${pressure}`,
    `swap ${size(st.swapUsedMb)}`,
    st.diskFreeGb >= 0 ? `disk ${st.diskFreeGb} GB` : "",
  ].filter(Boolean);
  lines.push(`${mark.dot(LOAD_TONE[st.load])} ${out.bold(LOAD_TITLE[st.load])}   ${out.dim(facts.join(" · "))}`);

  // Slots in use as pips; idle ones summarized.
  const outsideBySlot = new Map<string, number>();
  for (const e of st.external) outsideBySlot.set(e.slot, (outsideBySlot.get(e.slot) ?? 0) + 1);
  const busy = st.slots.filter((s) => s.used + (outsideBySlot.get(s.name) ?? 0) > 0);
  const idle = st.slots.length - busy.length;
  const slotText = busy.map((s) => `${s.name} ${pips(s.used, outsideBySlot.get(s.name) ?? 0, s.capacity)}`).join("   ");
  lines.push(
    `  ${slotText}${slotText ? "   " : ""}${out.dim(busy.length ? `${idle} more slot${idle === 1 ? "" : "s"} free` : `all ${idle} slots free`)}${out.dim(` · max ${st.maxConcurrent} at once`)}`,
  );
  if (st.jetsamSinceStart > 0) {
    lines.push(`  ${mark.warn()} macOS killed processes for memory ${st.jetsamSinceStart}× since Bouncer started`);
  }

  if (st.advice.length) {
    section("Worth doing");
    for (const a of st.advice) lines.push(`  ${mark.arrow()} ${a}`);
  }

  section("Inside", st.running.length ? String(st.running.length) : undefined);
  if (!st.running.length) lines.push(out.dim("  No heavy jobs running."));
  for (const j of st.running) lines.push(...jobLine(j, cmdWidth));

  section("In line", st.queued.length ? String(st.queued.length) : undefined);
  if (!st.queued.length) lines.push(out.dim("  Nobody waiting."));
  for (const j of st.queued) lines.push(...jobLine(j, cmdWidth));

  if (st.external.length) {
    section("Outside", "started without Bouncer, holding slots");
    for (const e of st.external) {
      const cmd = e.command.replace(/^\S*\//, "");
      lines.push(
        `  ${padStart(out.dim(String(e.pid)), 6)}  ${padEnd(e.slot, 7)} ${padEnd(truncate(cmd, cmdWidth), cmdWidth)}${padStart(size(e.rssMb), 8)}  ${padStart(duration(e.elapsedSec * 1000), 6)}`,
      );
    }
  }

  if (st.prioritized.length) {
    section("Prioritized");
    for (const p of st.prioritized)
      lines.push(`  ${truncate(p.session, 12)}  ${out.dim(`until ${new Date(p.until).toLocaleTimeString()}`)}`);
  }

  if (st.sessions.length) {
    const total = st.sessions.reduce((s, x) => s + x.rssMb, 0);
    const idleCount = st.sessions.filter((s) => s.idleSec >= 3600).length;
    section("Sessions", `${st.sessions.length} · ${size(total)}${idleCount ? ` · ${idleCount} idle 1h+` : ""}`);
    for (const s of st.sessions.slice(0, 8)) {
      const state =
        s.idleSec >= 3600
          ? out.yellow(`idle ${age(s.idleSec)}`)
          : s.idleSec >= 300
            ? `idle ${age(s.idleSec)}`
            : out.dim("active");
      lines.push(
        `  ${padEnd(s.kind, 7)} ${padEnd(truncate(basenameOf(s.cwd) || `pid ${s.pid}`, 28), 28)} ${padStart(size(s.rssMb), 8)}  ${out.dim(padEnd(`up ${age(s.elapsedSec)}`, 10))} ${state}`,
      );
    }
    if (st.sessions.length > 8) lines.push(out.dim(`  ${st.sessions.length - 8} more · bouncer status --json`));
  }
  return lines;
}

export async function statusCommand(args: string[]): Promise<void> {
  if (args.includes("--segment")) {
    // Statusline use: never error, never slow. Print nothing if the daemon is down.
    const reply = await ask({ op: "status" }, 500);
    if (reply?.type === "status") process.stdout.write(segment(reply.status));
    return;
  }
  const st = await fetchStatus();
  if (args.includes("--json")) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  if (args.includes("--line")) {
    const slots = st.slots.map((s) => `${s.name} ${s.used}/${s.capacity}`).join(" · ");
    const q = st.queued.length ? ` · ${st.queued.length} queued` : "";
    console.log(`${mark.dot(LOAD_TONE[st.load])} bouncer ${st.freePercent}% free · ${slots}${q}`);
    return;
  }
  console.log(renderStatus(st).join("\n"));
}

/** Live view, refreshed every second. Made for a cmux Dock pane. */
export async function watchCommand(): Promise<void> {
  const write = (s: string) => process.stdout.write(s);
  write("\x1b[?25l");
  const restore = () => {
    write("\x1b[?25h\n");
    process.exit(0);
  };
  process.on("SIGINT", restore);
  process.on("SIGTERM", restore);
  while (true) {
    const reply = await ask({ op: "status" }, 1500);
    const lines =
      reply?.type === "status"
        ? renderStatus(reply.status)
        : [
            `${mark.dot("red")} ${out.bold("Bouncer isn't running")}`,
            out.dim("  Builds run unguarded. Start it with bouncer install."),
          ];
    lines.push("", out.dim(`updated ${new Date().toLocaleTimeString()} · Ctrl-C to exit`));
    write(`\x1b[H\x1b[2J${lines.join("\n")}`);
    await Bun.sleep(1000);
  }
}

export async function historyCommand(args: string[]): Promise<void> {
  const limit = Number(args[0]) || 20;
  const reply = await ask({ op: "history", limit });
  if (reply?.type !== "history") notRunning();
  if (!reply.jobs.length) {
    console.log(out.dim("No finished jobs yet."));
    return;
  }
  const STATE: Record<string, string> = {
    done: out.green("done"),
    reaped: out.red("stopped"),
    cancelled: out.dim("cancelled"),
    preempted: out.yellow("preempted"),
  };
  console.log(
    out.dim(
      `${padStart("job", 5)}  ${padEnd("state", 10)}${padEnd("slot", 8)}${padStart("waited", 7)}${padStart("ran", 8)}${padStart("peak", 9)}  exit  command`,
    ),
  );
  for (const j of reply.jobs) {
    const waited = j.startedAt ? duration(j.startedAt - j.queuedAt) : "-";
    const ran = j.startedAt && j.endedAt ? duration(j.endedAt - j.startedAt) : "-";
    const exit = j.exitCode === null ? "-" : j.exitCode === 0 ? "0" : out.red(String(j.exitCode));
    console.log(
      `${padStart(out.dim(String(j.id)), 5)}  ${padEnd(STATE[j.state] ?? j.state, 10)}${padEnd(j.slot, 8)}${padStart(waited, 7)}${padStart(ran, 8)}${padStart(size(j.peakRssMb), 9)}  ${padEnd(exit, 4)}  ${truncate(j.cmd, Math.max(20, width() - 60))}`,
    );
  }
}

export async function prioritizeCommand(args: string[]): Promise<void> {
  const clear = args.includes("--clear");
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: bouncer prioritize [--clear] <job-id | session-id>");
    process.exit(2);
  }
  const msg = /^\d+$/.test(target)
    ? { op: "prioritize" as const, job: Number(target), clear }
    : { op: "prioritize" as const, session: target, clear };
  const reply = await ask(msg);
  if (!reply) notRunning();
  if (reply.type === "error") {
    console.error(`bouncer: ${reply.message}`);
    process.exit(1);
  }
  console.log(reply.type === "ok" ? (reply.message ?? "ok") : "ok");
}

export async function cancelCommand(args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id)) {
    console.error("usage: bouncer cancel <job-id>");
    process.exit(2);
  }
  const reply = await ask({ op: "cancel", job: id });
  if (!reply) notRunning();
  if (reply.type === "error") {
    console.error(`bouncer: ${reply.message}`);
    process.exit(1);
  }
  console.log(reply.type === "ok" ? (reply.message ?? "ok") : "ok");
}

/** `bouncer schedule [--at HH:MM | --in 30m] [--when-idle] -- <cmd> [args...]` */
export async function scheduleCommand(argv: string[]): Promise<void> {
  const usage = "usage: bouncer schedule [--at HH:MM | --in 30m] [--when-idle] -- <command> [args...]";
  let at: number | null = null;
  let whenIdle = false;
  let i = 0;
  try {
    for (; i < argv.length && argv[i] !== "--"; i++) {
      const a = argv[i]!;
      if (a === "--at") at = nextClockTime(argv[++i] ?? "", new Date());
      else if (a === "--in") at = Date.now() + parseDelay(argv[++i] ?? "");
      else if (a === "--when-idle") whenIdle = true;
      else throw new Error(`unknown option ${a}`);
    }
  } catch (e) {
    console.error(`bouncer: ${(e as Error).message}\n${usage}`);
    process.exit(2);
  }
  const cmd = argv.slice(i + 1);
  if (!cmd.length || (at === null && !whenIdle)) {
    console.error(usage);
    process.exit(2);
  }
  const reply = await ask({
    op: "schedule",
    argv: cmd,
    cwd: process.cwd(),
    env: pickEnv(process.env),
    session: sessionId(),
    at,
    whenIdle,
  });
  if (!reply) notRunning();
  if (reply.type === "error") {
    console.error(`bouncer: ${reply.message}`);
    process.exit(1);
  }
  const when = [at ? `at ${new Date(at).toLocaleString()}` : "", whenIdle ? "when the machine is idle" : ""]
    .filter(Boolean)
    .join(", ");
  console.log(
    `${mark.ok()} ${out.bold(reply.type === "ok" ? (reply.message ?? "scheduled") : "scheduled")}  ${cmd.join(" ")}  ${out.dim(when)}`,
  );
}

export async function scheduledCommand(args: string[]): Promise<void> {
  const reply = await ask({ op: "scheduled", all: args.includes("--all") });
  if (reply?.type !== "scheduled") notRunning();
  if (!reply.items.length) {
    console.log(out.dim("Nothing scheduled. Try: bouncer schedule --at 02:00 -- pnpm test"));
    return;
  }
  for (const r of reply.items) {
    const when = r.at ? new Date(r.at).toLocaleString() : "";
    const idle = r.whenIdle ? " when idle" : "";
    const exit = r.exitCode !== null ? ` exit ${r.exitCode}` : "";
    console.log(
      `  ${padEnd(`s${r.id}`, 5)} ${padEnd(r.state, 10)}${padEnd(when + idle, 26)} ${truncate(r.argv.join(" "), 44)}${exit}`,
    );
    console.log(`  ${" ".repeat(5)} ${out.dim(homeRel(r.logPath))}`);
  }
}

export async function unscheduleCommand(args: string[]): Promise<void> {
  const id = Number((args[0] ?? "").replace(/^s/, ""));
  if (!Number.isInteger(id) || id <= 0) {
    console.error("usage: bouncer unschedule <s-id>");
    process.exit(2);
  }
  const reply = await ask({ op: "unschedule", id });
  if (!reply) notRunning();
  if (reply.type === "error") {
    console.error(`bouncer: ${reply.message}`);
    process.exit(1);
  }
  console.log(reply.type === "ok" ? reply.message : "ok");
}
