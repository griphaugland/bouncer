import { existsSync } from "node:fs";
import { basename } from "node:path";
import { classifyCommandString, commandSegments, type Segment } from "./classify";
import { ask } from "./conn";
import { paths } from "./paths";
import { safeTools } from "./run";

// "prioritize this / it / that / these …" (and Norwegian "prioriter dette / det"): an
// instruction about the current work. A bare verb matched far too much: "prioritize
// readability", or a pasted review that mentions the word (review #8, and it happened live).
export const PRIORITIZE =
  /\b(?:prioriti[sz]e|prioriter)\s+(?:this|it|that|these|this one|this build|this task|my build|my tests?|dette|det|denne)\b/i;

async function readStdin(): Promise<any> {
  try {
    return JSON.parse(await Bun.stdin.text());
  } catch {
    return null;
  }
}

function emit(output: unknown): void {
  process.stdout.write(JSON.stringify(output));
}

/**
 * Commands only the human may run. An agent that bypasses the gate or reorders the queue for
 * itself defeats the point, and agents do reach for whatever makes their own task finish first.
 */
// Only actual invocations count (first word of a shell segment, heredoc bodies stripped), so an
// agent can still write docs or code that merely mention these commands.
function humanOnly({ env, argv }: Segment): string | null {
  // Any BOUNCER_* variable: BYPASS and JOB skip the gate, SESSION borrows another session's
  // priority, HOME points the shim at a socket that doesn't exist (review finding #4).
  const ours = (s: string) => /^BOUNCER_[A-Z_]+=/.test(s);
  const exported = ["export", "declare", "typeset"].includes(argv[0] ?? "") ? argv.slice(1) : [];
  const hit = [...env, ...exported].find(ours);
  if (hit) return `setting ${hit.split("=")[0]} (it changes how Bouncer queues builds)`;
  const [cmd = "", sub = ""] = argv;
  if (basename(cmd) === "bouncer") {
    if (["prioritize", "cancel", "unschedule", "uninstall"].includes(sub)) return "changing Bouncer's queue or install";
    if (sub === "clean" && argv.includes("--apply")) return "deleting files with bouncer clean --apply";
  }
  if (
    basename(cmd) === "launchctl" &&
    ["bootout", "unload", "kill", "disable", "remove"].includes(sub) &&
    argv.some((a) => a.includes("com.bouncer"))
  ) {
    return "stopping the Bouncer daemon";
  }
  return null;
}

export function humanOnlyReason(command: string): string | null {
  for (const segment of commandSegments(command)) {
    const what = humanOnly(segment);
    if (what) {
      return `Bouncer: ${what} is reserved for the user. Ask them to do it (or to say "prioritize this" if this work is urgent), or run the command normally and let it wait its turn.`;
    }
  }
  return null;
}

/**
 * Claude Code PreToolUse (matcher: Bash). Never blocks the agent's work and never adds a
 * permission prompt; every failure path exits 0 with no output, which leaves the call as it was.
 *
 * If a heavy command would have to wait, move it to the background so the queue wait can't
 * hit the Bash tool's 2-10 minute timeout. The shim on PATH does the actual gating.
 */
export type HookAgent = "claude" | "codex";

export function hookAgent(args: string[]): HookAgent {
  const i = args.indexOf("--agent");
  return args[i + 1] === "codex" ? "codex" : "claude";
}

/**
 * The command with Bouncer's shims first on PATH. A session inherits PATH from the terminal it
 * started in, so one opened before `bouncer setup` runs builds straight past the queue; this is
 * how the hook, which every session does load, puts those builds back in line.
 */
export function throughShims(command: string, shimDir = paths.shimDir): string {
  const quoted = shimDir.replace(/(["\\$`])/g, "\\$1");
  return `export PATH="${quoted}:$PATH"; ${command}`;
}

/** Already gated: the session has the shims on PATH, or the command puts them there itself. */
function gated(command: string): boolean {
  return (process.env.PATH ?? "").split(":").includes(paths.shimDir) || command.includes(paths.shimDir);
}

export async function preToolHook(agent: HookAgent = "claude"): Promise<void> {
  const input = await readStdin();
  if (input?.tool_name !== "Bash") return;
  const toolInput = input.tool_input ?? {};
  if (typeof toolInput.command !== "string") return;

  const forbidden = humanOnlyReason(toolInput.command);
  if (forbidden) {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: forbidden,
      },
    });
    return;
  }

  const slots = classifyCommandString(toolInput.command, safeTools());
  if (!slots.length || !existsSync(paths.shimDir)) return;
  const old = !gated(toolInput.command);
  const command = old ? throughShims(toolInput.command) : toolInput.command;

  // Would it have to wait? Only Claude Code can move a call to the background; a Codex build
  // just waits in the foreground inside the shim.
  let busy: string | null = null;
  if (agent === "claude" && !toolInput.run_in_background) {
    const reply = await ask({ op: "probe", slots, session: input.session_id ?? "" }, 800);
    if (reply?.type === "probe" && !reply.wouldRun) busy = reply.reason;
  }
  if (!old && !busy) return;

  const why = old ? "this session started before Bouncer was installed, so its builds would skip the queue" : "";
  if (agent === "claude" && input.permission_mode === "bypassPermissions") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: busy
          ? `Bouncer: ${busy}. Queued; running in the background, you will be notified when it finishes.`
          : `Bouncer: ${why}; running it through the queue.`,
        updatedInput: { ...toolInput, command, ...(busy ? { run_in_background: true } : {}) },
      },
    });
    return;
  }
  // "allow" would also skip the permission prompt the user expects in other modes, so there the
  // agent resubmits the call itself and it gets the usual prompt.
  // The command goes last, on its own line, so nothing (not even a full stop) gets copied with it.
  const problem = [why, busy ? `the machine is busy (${busy})` : ""].filter(Boolean).join("; ");
  const background = busy
    ? " with run_in_background: true; it will wait its turn and you will be notified when it finishes"
    : "";
  const reason = old
    ? `Bouncer: ${problem}. Run this exact command instead${background}:\n${command}`
    : `Bouncer: ${problem}. Run this exact command again${background}.`;
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/** Claude Code UserPromptSubmit. Only the human's own prompt can raise a session's priority. */
export async function promptHook(): Promise<void> {
  const input = await readStdin();
  const prompt: string = input?.prompt ?? "";
  const session: string | undefined = input?.session_id;
  const cwd: string | undefined = input?.cwd;
  if ((!session && !cwd) || !PRIORITIZE.test(prompt)) return;
  // Session for agents whose builds carry the same id (Claude Code); folder for the rest (Codex).
  const reply = await ask({ op: "prioritize", session, cwd }, 1500);
  if (reply?.type !== "ok") return;
  emit({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `Bouncer: builds from this session and project now run first (${reply.message}). Other jobs may be paused and rerun to make room.`,
    },
  });
}
