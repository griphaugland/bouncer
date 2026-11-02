import { classifyCommandString } from "./classify";
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
 * Claude Code PreToolUse (matcher: Bash). Never blocks the agent's work and never adds a
 * permission prompt; every failure path exits 0 with no output, which leaves the call as it was.
 *
 * If a heavy command would have to wait, move it to the background so the queue wait can't
 * hit the Bash tool's 2-10 minute timeout. The shim on PATH does the actual gating.
 */
export async function preToolHook(): Promise<void> {
  const input = await readStdin();
  if (input?.tool_name !== "Bash") return;
  const toolInput = input.tool_input ?? {};
  if (toolInput.run_in_background || typeof toolInput.command !== "string") return;

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
  if (!session || !PRIORITIZE.test(prompt)) return;
  const reply = await ask({ op: "prioritize", session }, 1500);
  if (reply?.type !== "ok") return;
  emit({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `Bouncer: this session's builds and tests now run first (${reply.message}). Other sessions' jobs may be paused and rerun to make room.`,
    },
  });
}
