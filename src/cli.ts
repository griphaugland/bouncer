import { ask } from "./conn";
import type { JobView, Load, StatusSnapshot } from "./protocol";
import { sessionId } from "./run";
import { nextClockTime, parseDelay, pickEnv } from "./schedule";
import { VERSION } from "./version";

const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c("2", s);
const bold = (s: string) => c("1", s);
const LOAD_COLOR: Record<Load, string> = { green: "32", yellow: "33", red: "31" };
const PRESSURE: Record<number, string> = { 1: "normal", 2: "warn", 4: "critical" };

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function shortSession(s: string): string {
  return s.length > 14 ? `${s.slice(0, 8)}…` : s;
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function notRunning(): never {
  console.error("bouncer: daemon is not running. Start it with `bouncer install` or `bouncer daemon`.");
  process.exit(1);
}

async function fetchStatus(): Promise<StatusSnapshot> {
  const reply = await ask({ op: "status" });
  if (reply?.type !== "status") notRunning();
  if (reply.status.version !== VERSION) {
    process.stderr.write(
      `bouncer: the running daemon is v${reply.status.version ?? "?"} but this CLI is v${VERSION}. Run \`bouncer install\` to restart it.\n`,
    );
  }
  return reply.status;
}

function jobLine(j: JobView): string {
  const prio = j.priority === "high" ? c("35", " ★") : "";
  const time = duration(j.elapsedMs);
  const extra =
    j.state === "running"
      ? `${String(j.rssMb).padStart(6)} MB  ${time}`
      : `#${j.position} ${time}  ${dim(j.waitReason ?? "")}`;
  return `  ${String(j.id).padStart(4)}  ${j.slot.padEnd(7)} ${shortSession(j.session).padEnd(10)} ${trim(j.cmd, 42).padEnd(42)} ${extra}${prio}`;
}

function homeRel(path?: string): string {
  if (!path) return "";
  const home = process.env.HOME ?? "";
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Compact segment for a statusline: quiet when idle, loud when something waits or memory is tight. */
export function segment(st: StatusSnapshot): string {
  const dot = c(LOAD_COLOR[st.load], "●");
  const parts: string[] = [];
  if (st.running.length) parts.push(`${st.running.length} running`);
  if (st.queued.length) parts.push(c("33", `${st.queued.length} queued`));
  if (st.external.length) parts.push(c("33", `${st.external.length} outside`));
  if (st.load !== "green") parts.push(c(LOAD_COLOR[st.load], `${st.freePercent}% free`));
  return parts.length ? `${dot} bouncer ${parts.join(" · ")}` : `${dot} bouncer`;
}

export function renderStatus(st: StatusSnapshot): string[] {
  const out: string[] = [];
  const pressure = PRESSURE[st.pressureLevel] ?? String(st.pressureLevel);
  out.push(
    `${c(LOAD_COLOR[st.load], `● ${st.load.toUpperCase()}`)}  memory ${st.freePercent}% free, pressure ${pressure}, swap ${(st.swapUsedMb / 1024).toFixed(1)}/${(st.swapTotalMb / 1024).toFixed(1)} GB`,
  );
  out.push(
    dim(
      `  slots: ${st.slots.map((s) => `${s.name} ${s.used}/${s.capacity}`).join("  ")}   max ${st.maxConcurrent} at once   disk ${st.diskFreeGb >= 0 ? `${st.diskFreeGb} GB free` : "?"}   jetsam since start: ${st.jetsamSinceStart}`,
    ),
  );
  if (st.advice.length) {
    out.push("", bold("Advice"));
    for (const a of st.advice) out.push(`  ${c("33", "→")} ${a}`);
  }
  out.push("", bold(`Running (${st.running.length})`));
  if (!st.running.length) out.push(dim("  nothing"));
  for (const j of st.running) out.push(jobLine(j));
  out.push("", bold(`Queued (${st.queued.length})`));
  if (!st.queued.length) out.push(dim("  nothing"));
  for (const j of st.queued) out.push(jobLine(j));
  if (st.external.length) {
    out.push("", bold(`Outside Bouncer (${st.external.length})`) + dim("  heavy builds it did not start; they hold slots"));
    for (const e of st.external) {
      out.push(
        `  ${String(e.pid).padStart(6)}  ${e.slot.padEnd(7)} ${trim(e.command.replace(/^\S*\//, ""), 52).padEnd(52)} ${String(e.rssMb).padStart(6)} MB  ${duration(e.elapsedSec * 1000)}`,
      );
    }
  }
  if (st.prioritized.length) {
    out.push("", bold("Prioritized sessions"));
    for (const p of st.prioritized) out.push(`  ${shortSession(p.session)}  until ${new Date(p.until).toLocaleTimeString()}`);
  }
  if (st.sessions.length) {
    const total = st.sessions.reduce((s, x) => s + x.rssMb, 0);
    const claude = st.sessions.filter((s) => s.kind === "claude").length;
    out.push(
      "",
      bold(`Sessions (${claude} claude, ${st.sessions.length - claude} codex)`) + dim(`  ${(total / 1024).toFixed(1)} GB together`),
    );
    for (const s of st.sessions.slice(0, 8)) {
      const idle = s.idleSec >= 300 ? c("33", `idle ${duration(s.idleSec * 1000)}`) : dim("active");
      out.push(
        `  ${String(s.pid).padStart(6)}  ${s.kind.padEnd(6)} ${String(s.rssMb).padStart(6)} MB  up ${duration(s.elapsedSec * 1000).padEnd(7)} ${idle.padEnd(tty ? 22 : 13)} ${dim(trim(homeRel(s.cwd), 50))}`,
      );
    }
    if (st.sessions.length > 8) out.push(dim(`  … ${st.sessions.length - 8} more (bouncer status --json)`));
  }
  out.push("", bold("Biggest memory users"));
  for (const p of st.topProcesses.slice(0, 6)) {
    out.push(`  ${String(p.rssMb).padStart(6)} MB  ${String(p.count).padStart(3)}×  ${p.name}`);
  }
  return out;
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
    console.log(`${c(LOAD_COLOR[st.load], "●")} bouncer ${st.freePercent}% free · ${slots}${q}`);
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
        : [c("31", "● bouncer daemon not running"), dim("  start it with `bouncer install`")];
    lines.push("", dim(`updated ${new Date().toLocaleTimeString()} · Ctrl-C to exit`));
    write(`\x1b[H\x1b[2J${lines.join("\n")}`);
    await Bun.sleep(1000);
  }
}

export async function historyCommand(args: string[]): Promise<void> {
  const limit = Number(args[0]) || 20;
  const reply = await ask({ op: "history", limit });
  if (reply?.type !== "history") notRunning();
  for (const j of reply.jobs) {
    const waited = j.startedAt ? duration(j.startedAt - j.queuedAt) : "-";
    const ran = j.startedAt && j.endedAt ? duration(j.endedAt - j.startedAt) : "-";
    console.log(
      `${String(j.id).padStart(5)}  ${j.state.padEnd(9)} ${j.slot.padEnd(7)} wait ${waited.padEnd(7)} ran ${ran.padEnd(7)} ${String(j.peakRssMb).padStart(6)} MB  exit ${String(j.exitCode ?? "-").padEnd(4)} ${trim(j.cmd, 50)}`,
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
  console.log(`${reply.type === "ok" ? reply.message : "scheduled"}: ${cmd.join(" ")}  (${when})`);
}

export async function scheduledCommand(args: string[]): Promise<void> {
  const reply = await ask({ op: "scheduled", all: args.includes("--all") });
  if (reply?.type !== "scheduled") notRunning();
  if (!reply.items.length) {
    console.log(dim("nothing scheduled"));
    return;
  }
  for (const r of reply.items) {
    const when = r.at ? new Date(r.at).toLocaleString() : "";
    const idle = r.whenIdle ? " when idle" : "";
    const exit = r.exitCode !== null ? ` exit ${r.exitCode}` : "";
    console.log(
      `  s${String(r.id).padEnd(4)} ${r.state.padEnd(9)} ${(when + idle).padEnd(28)} ${trim(r.argv.join(" "), 44).padEnd(44)}${exit}  ${dim(homeRel(r.logPath))}`,
    );
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
