import { cancelCommand, historyCommand, prioritizeCommand, statusCommand } from "./cli";
import { runDaemon } from "./daemon";
import { preToolHook, promptHook } from "./hooks";
import { install, uninstall } from "./install";
import { gatedRun, resolveReal, runCommand } from "./run";

const HELP = `bouncer: makes heavy builds and tests wait their turn so your machine never runs out of memory.

  bouncer status [--json|--line]     load, slots, running and queued jobs
  bouncer history [n]                last n finished jobs
  bouncer prioritize <job|session>   move a session's jobs to the front (--clear to undo)
  bouncer cancel <job>               stop a queued or running job
  bouncer run [--slot s] -- <cmd>    run any command through the gate
  bouncer install | uninstall        set up / remove daemon, shims and Claude Code hooks
  bouncer daemon                     run the daemon in the foreground

Internal: bouncer shim <tool> [args]   bouncer hook pre-tool|prompt`;

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "daemon":
    await runDaemon();
    break;
  case "shim": {
    const [tool, ...rest] = args;
    const real = tool ? resolveReal(tool) : null;
    if (!tool || !real) {
      console.error(`bouncer: ${tool ?? "?"}: command not found`);
      process.exit(127);
    }
    await gatedRun({ tool, real, args: rest });
    break;
  }
  case "run":
    await runCommand(args);
    break;
  case "hook":
    // Hooks must never break the agent: any crash is swallowed and exits 0.
    try {
      if (args[0] === "pre-tool") await preToolHook();
      else if (args[0] === "prompt") await promptHook();
    } catch {}
    process.exit(0);
  case "status":
  case "queue":
    await statusCommand(args);
    break;
  case "history":
    await historyCommand(args);
    break;
  case "prioritize":
    await prioritizeCommand(args);
    break;
  case "cancel":
    await cancelCommand(args);
    break;
  case "install":
    install();
    break;
  case "uninstall":
    uninstall(args);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`bouncer: unknown command "${cmd}"\n\n${HELP}`);
    process.exit(2);
}
