import { ask } from "./conn";
import type { JobView, Load, StatusSnapshot } from "./protocol";

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

export async function statusCommand(args: string[]): Promise<void> {
  const st = await fetchStatus();
  if (args.includes("--json")) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  if (args.includes("--line")) {
    // One line for a statusline / cmux / prompt.
    const slots = st.slots.map((s) => `${s.name} ${s.used}/${s.capacity}`).join(" · ");
    const q = st.queued.length ? ` · ${st.queued.length} queued` : "";
    console.log(`${c(LOAD_COLOR[st.load], "●")} bouncer ${st.freePercent}% free · ${slots}${q}`);
    return;
  }

  const pressure = PRESSURE[st.pressureLevel] ?? String(st.pressureLevel);
  console.log(
    `${c(LOAD_COLOR[st.load], `● ${st.load.toUpperCase()}`)}  memory ${st.freePercent}% free, pressure ${pressure}, swap ${(st.swapUsedMb / 1024).toFixed(1)}/${(st.swapTotalMb / 1024).toFixed(1)} GB`,
  );
  console.log(
    dim(
      `  slots: ${st.slots.map((s) => `${s.name} ${s.used}/${s.capacity}`).join("  ")}   max ${st.maxConcurrent} at once   jetsam since start: ${st.jetsamSinceStart}`,
    ),
  );
  console.log();
  console.log(bold(`Running (${st.running.length})`));
  if (!st.running.length) console.log(dim("  nothing"));
  for (const j of st.running) console.log(jobLine(j));
  console.log();
  console.log(bold(`Queued (${st.queued.length})`));
  if (!st.queued.length) console.log(dim("  nothing"));
  for (const j of st.queued) console.log(jobLine(j));
  if (st.prioritized.length) {
    console.log();
    console.log(bold("Prioritized sessions"));
    for (const p of st.prioritized) console.log(`  ${shortSession(p.session)}  until ${new Date(p.until).toLocaleTimeString()}`);
  }
  console.log();
  console.log(bold("Biggest memory users"));
  for (const p of st.topProcesses.slice(0, 6)) {
    console.log(`  ${String(p.rssMb).padStart(6)} MB  ${String(p.count).padStart(3)}×  ${p.name}`);
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
