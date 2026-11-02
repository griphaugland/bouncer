import { basename } from "node:path";
import { classifyCommandString, commandSegments, type Segment } from "./classify";
import { ask } from "./conn";
import { paths } from "./paths";
import { safeTools } from "./run";

// The verb only ("prioritize this"), not the noun ("what's the priority here"). Norwegian too.
const PRIORITIZE = /\b(prioriti[sz]e|prioriter)\b/i;

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
  const bypass = (s: string) => s.startsWith("BOUNCER_BYPASS=");
  if (env.some(bypass) || (argv[0] === "export" && argv.slice(1).some(bypass))) {
    return "skipping the Bouncer queue (BOUNCER_BYPASS)";
  }
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
  // Codex has no background runs: its queued builds simply wait in the foreground (the shim
  // handles that). Only the guard above applies.
  if (agent !== "claude" || toolInput.run_in_background) return;

  // Sessions started before `bouncer install` don't have the shims on PATH; nothing would gate.
  if (!(process.env.PATH ?? "").split(":").includes(paths.shimDir)) return;

  const slots = classifyCommandString(toolInput.command, safeTools());
  if (!slots.length) return;

  const reply = await ask({ op: "probe", slots, session: input.session_id ?? "" }, 800);
  if (reply?.type !== "probe" || reply.wouldRun) return;

  const reason = `Bouncer: ${reply.reason}. Queued; running in the background, you will be notified when it finishes.`;
  if (input.permission_mode === "bypassPermissions") {
    emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
        updatedInput: { ...toolInput, run_in_background: true },
      },
    });
    return;
  }
  // "allow" would also skip the permission prompt the user expects in other modes, so there
  // we tell the agent to resubmit in the background instead of rewriting the call ourselves.
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `Bouncer: the machine is busy (${reply.reason}). Run this exact command again with run_in_background: true; it will wait its turn and you will be notified when it finishes.`,
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
