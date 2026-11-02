import { accessSync, constants } from "node:fs";
import { basename, delimiter, join } from "node:path";
import { constants as osConstants } from "node:os";
import { classifyInvocation, DEFAULT_TOOL_RULES, type ToolRules } from "./classify";
import { loadPolicy } from "./policy";
import { Conn } from "./conn";
import { paths } from "./paths";
import { getPlatform, killTree } from "./platform";
import type { ServerMsg } from "./protocol";

const STOP_GRACE_MS = 10_000;

/** Tool rules from the policy; a broken policy file must never stop a build, so fall back. */
export function safeTools(): ToolRules {
  try {
    return loadPolicy().tools;
  } catch {
    return DEFAULT_TOOL_RULES;
  }
}

function say(line: string): void {
  process.stderr.write(`\x1b[2m[bouncer] ${line}\x1b[0m\n`);
}

/** Who is asking. Claude Code exports its session id into every Bash command it runs. */
export function sessionId(): string {
  return (
    process.env.BOUNCER_SESSION ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    (process.env.CMUX_PANEL_ID ? `cmux:${process.env.CMUX_PANEL_ID}` : undefined) ??
    `term:${process.ppid}`
  );
}

/** First executable named `name` on PATH that is not one of our shims. */
export function resolveReal(name: string): string | null {
  if (name.includes("/")) return name;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || dir === paths.shimDir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function exitCodeOf(proc: { exitCode: number | null; signalCode: string | number | null }): number {
  if (proc.exitCode !== null) return proc.exitCode;
  const sig =
    typeof proc.signalCode === "number"
      ? proc.signalCode
      : proc.signalCode
        ? (osConstants.signals as Record<string, number>)[proc.signalCode]
        : undefined;
  return 128 + (sig ?? 1);
}

/**
 * Keep the shim alive until its child exits. Terminal Ctrl-C already reaches the child (same
 * process group), so SIGINT is only swallowed; SIGTERM/SIGHUP sent to the shim alone are forwarded.
 */
function relaySignals(getChild: () => { kill(sig: NodeJS.Signals): void } | undefined, onIdle: () => void): void {
  process.on("SIGINT", () => {
    if (!getChild()) onIdle();
  });
  for (const sig of ["SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      const child = getChild();
      if (child) child.kill(sig);
      else onIdle();
    });
  }
}

/** Run without asking anyone: light commands, nested calls, and the fail-open path. */
async function passthrough(real: string, args: string[]): Promise<never> {
  const proc = Bun.spawn([real, ...args], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  relaySignals(() => proc, () => process.exit(130));
  await proc.exited;
  process.exit(exitCodeOf(proc));
}

/**
 * The gate. Ask the daemon for a slot, wait for our turn, run the command, report back.
 * If preempted, kill the command and run it again when the slot comes back.
 */
export async function gatedRun(opts: { tool: string; real: string; args: string[]; slot?: string }): Promise<never> {
  const { real, args } = opts;
  if (process.env.BOUNCER_JOB || process.env.BOUNCER_BYPASS) return passthrough(real, args);

  const slot = opts.slot ?? classifyInvocation(opts.tool, args, safeTools());
  if (!slot) return passthrough(real, args);

  const conn = await Conn.open(1000);
  if (!conn) {
    say("daemon not running, running unguarded");
    return passthrough(real, args);
  }

  const platform = getPlatform();
  const cmd = [opts.tool, ...args].join(" ");
  let jobId: number | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stopReason: "preempt" | "reap" | undefined;
  let reapMessage = "";
  let resolveRun: (() => void) | undefined;
  let finished = false;

  const waitForRun = () => new Promise<void>((r) => (resolveRun = r));
  let runGate = waitForRun();

  conn.onMessage((msg: ServerMsg) => {
    switch (msg.type) {
      case "queued":
        jobId = msg.job;
        say(`queued job ${msg.job} [${slot}] position ${msg.position}: ${msg.reason}`);
        break;
      case "run":
        jobId = msg.job;
        resolveRun?.();
        break;
      case "preempt":
        stopReason = "preempt";
        say(`job ${msg.job} paused for higher-priority job ${msg.by}; will rerun when the slot frees`);
        if (child) void killTree(platform, child.pid, STOP_GRACE_MS);
        break;
      case "reap":
        stopReason = "reap";
        reapMessage = msg.reason;
        if (child) {
          say(`job ${msg.job} stopped: ${msg.reason}`);
          void killTree(platform, child.pid, STOP_GRACE_MS);
        } else {
          say(`job ${msg.job} cancelled before it started: ${msg.reason}`);
          process.exit(130);
        }
        break;
    }
  });

  let daemonGone = false;
  conn.onClose(() => {
    daemonGone = true;
    // Lost the daemon while waiting: fail open rather than hang forever.
    if (!child && !finished) {
      say("lost the daemon while queued, running unguarded");
      resolveRun?.();
    }
  });

  conn.send({ op: "admit", slot, cmd, cwd: process.cwd(), session: sessionId(), pid: process.pid });

  relaySignals(
    () => child,
    () => {
      conn.close();
      process.exit(130);
    },
  );

  while (true) {
    await runGate;
    const env = { ...process.env, BOUNCER_JOB: String(jobId ?? "unguarded") };
    child = Bun.spawn([real, ...args], { stdio: ["inherit", "inherit", "inherit"], env });
    if (jobId !== undefined && !daemonGone) conn.send({ op: "started", job: jobId, childPid: child.pid });
    await child.exited;
    const code = exitCodeOf(child);
    child = undefined;

    if (stopReason === "preempt" && !daemonGone && jobId !== undefined) {
      stopReason = undefined;
      runGate = waitForRun();
      conn.send({ op: "requeue", job: jobId });
      continue;
    }

    finished = true;
    if (stopReason === "reap") {
      say(`killed by Bouncer (${reapMessage}). Retry when \`bouncer status\` is green.`);
    }
    if (jobId !== undefined && !daemonGone) conn.send({ op: "done", job: jobId, exitCode: code });
    conn.close();
    process.exit(stopReason === "reap" ? 137 : code);
  }
}

/** `bouncer run [--slot name] -- <cmd> [args...]` */
export async function runCommand(argv: string[]): Promise<never> {
  let slot: string | undefined;
  let i = 0;
  while (i < argv.length && argv[i] !== "--") {
    if (argv[i] === "--slot") slot = argv[++i];
    else break;
    i++;
  }
  if (argv[i] === "--") i++;
  const [cmd, ...args] = argv.slice(i);
  if (!cmd) {
    console.error("usage: bouncer run [--slot name] -- <command> [args...]");
    process.exit(2);
  }
  const real = resolveReal(cmd);
  if (!real) {
    console.error(`bouncer: ${cmd}: command not found`);
    process.exit(127);
  }
  const tool = basename(cmd);
  return gatedRun({ tool, real, args, slot: slot ?? classifyInvocation(tool, args, safeTools()) ?? "misc" });
}
