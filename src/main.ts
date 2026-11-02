import {
  cancelCommand,
  historyCommand,
  prioritizeCommand,
  scheduleCommand,
  scheduledCommand,
  statusCommand,
  unscheduleCommand,
  watchCommand,
} from "./cli";
import { runDaemon } from "./daemon";
import { doctorCommand } from "./doctor";
import { hookAgent, preToolHook, promptHook } from "./hooks";
import { uninstall, writeShims } from "./install";
import { cleanCommand } from "./janitor";
import { gatedRun, resolveReal, runCommand } from "./run";
import { runSetup, tuneCommand } from "./setup";
import { VERSION } from "./version";

const HELP = `bouncer ${VERSION}: makes heavy builds and tests wait their turn so your machine never runs out of memory.

  bouncer status [--json|--line|--segment]  load, slots, jobs, sessions, advice
  bouncer watch                      live status (cmux Dock pane)
  bouncer history [n]                last n finished jobs
  bouncer prioritize <job|session>   move a session's jobs to the front (--clear to undo)
  bouncer cancel <job>               stop a queued or running job
  bouncer run [--slot s] -- <cmd>    run any command through the gate
  bouncer schedule [--at 02:00 | --in 30m] [--when-idle] -- <cmd>
                                     run later; output in ~/.bouncer/logs, notifies when done
  bouncer scheduled [--all]          list scheduled jobs
  bouncer unschedule <s-id>          drop a pending scheduled job
  bouncer clean [--apply <id…>|all]  find disk space; dry run unless --apply
  bouncer install [--yes]            guided setup: scans this Mac, connects your agents, tunes limits
  bouncer setup                      run the setup again (change agents, sessions, extras)
  bouncer tune [--apply]             re-scan this Mac and compare with your policy
  bouncer uninstall [--purge]        remove everything Bouncer added
  bouncer doctor                     check the install, PATH, hooks and daemon; prints fixes
  bouncer shims                      regenerate shims after editing tools: in policy.yaml
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
      if (args[0] === "pre-tool") await preToolHook(hookAgent(args));
      else if (args[0] === "prompt") await promptHook();
    } catch {}
    process.exit(0);
    break;
  case "status":
  case "queue":
    await statusCommand(args);
    break;
  case "watch":
    await watchCommand();
    break;
  case "schedule":
    await scheduleCommand(args);
    break;
  case "scheduled":
    await scheduledCommand(args);
    break;
  case "unschedule":
    await unscheduleCommand(args);
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
  case "clean":
    await cleanCommand(args);
    break;
  case "doctor":
    await doctorCommand();
    break;
  case "shims":
    console.log(`shims: ${writeShims().join(", ")}`);
    break;
  case "install":
  case "setup":
    await runSetup({ yes: args.includes("--yes") || args.includes("-y") });
    break;
  case "tune":
    await tuneCommand(args);
    break;
  case "uninstall":
    uninstall(args);
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(VERSION);
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
