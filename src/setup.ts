import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Agent, agents, LEVEL_TEXT } from "./agents";
import { readJson, writeJson } from "./files";
import { hasCmux, type InstallPlan, performInstall } from "./install";
import { describe, type MachineProfile, MIN_MACOS, macosMajor, recommend, scanMachine, type Tuning } from "./machine";
import { agentSessions } from "./observe";
import { paths, userHome } from "./paths";
import { getPlatform } from "./platform";
import { DEFAULT_POLICY, loadPolicy, type Policy, renderPolicy } from "./policy";
import { mark, out, padEnd } from "./term";
import { Cancelled, interactive, type Option, prompt } from "./tui";
import { VERSION } from "./version";

// `bouncer install` / `bouncer setup`: scan the Mac, ask which agents to connect and how you
// work, show the plan, then install. `--yes` (or no terminal) uses saved or detected choices.

export interface SetupChoices {
  agents: string[];
  sessions: number;
  statusLine: boolean;
  cmuxDock: boolean;
}

const setupFile = () => join(paths.home, "setup.json");

function savedChoices(): Partial<SetupChoices> {
  try {
    return readJson(setupFile()) as Partial<SetupChoices>;
  } catch {
    return {};
  }
}

const SESSION_BUCKETS: Option<number>[] = [
  { label: "1-3", value: 2, hint: "one agent, the odd second one" },
  { label: "4-8", value: 6, hint: "a few agents side by side" },
  { label: "9-15", value: 12, hint: "a busy day" },
  { label: "16+", value: 20, hint: "an agent fleet" },
];

function bucketFor(n: number): number {
  return n <= 3 ? 2 : n <= 8 ? 6 : n <= 15 ? 12 : 20;
}

/** Agent sessions running right now: the best guess at how this person works. */
function liveSessions(): number {
  try {
    return agentSessions(getPlatform().listProcesses()).length;
  } catch {
    return 0;
  }
}

function tunedPolicy(base: Policy, t: Tuning): Policy {
  return { ...base, maxConcurrent: t.maxConcurrent, slots: { ...base.slots, ...t.slots }, gate: t.gate };
}

function header(m: MachineProfile, t: Tuning, sessions: number): string[] {
  return [
    `Tuned for: ${describe(m)}, ~${sessions} agent sessions (${new Date().toISOString().slice(0, 10)}).`,
    ...t.reasons.map((r) => `  ${r}`),
  ];
}

function same(a: Policy, b: Policy): boolean {
  return (
    a.maxConcurrent === b.maxConcurrent &&
    JSON.stringify(a.gate) === JSON.stringify(b.gate) &&
    Object.entries(b.slots).every(([k, v]) => a.slots[k] === v)
  );
}

function checkMachine(m: MachineProfile): void {
  if (macosMajor(m.macos) < MIN_MACOS) {
    console.error(`${mark.fail()} Bouncer needs macOS ${MIN_MACOS} or later; this Mac runs ${m.macos}.`);
    process.exit(1);
  }
  if (m.translated) {
    console.log(
      `${mark.warn()} This is the Intel build running under Rosetta on Apple Silicon. It works, but the arm64 build is faster:\n  ${out.dim("brew reinstall bouncer, or download bouncer-*-darwin-arm64.tar.gz")}`,
    );
  }
}

function agentOptions(list: Agent[]): Option<string>[] {
  return list.map((a) => {
    const found = a.detect();
    return {
      label: a.name,
      value: a.id,
      disabled: !found,
      hint: found ? LEVEL_TEXT[a.level] : "not found on this Mac",
    };
  });
}

function intro(m: MachineProfile): void {
  const row = (k: string, v: string) => console.log(`  ${out.dim(padEnd(k, 11))}${v}`);
  console.log(
    `\n${out.bold(`Bouncer ${VERSION}`)}  ${out.dim("queues heavy builds so your agents can share this Mac")}\n`,
  );
  row("This Mac", describe(m));
  row("Toolchains", m.toolchains.length ? m.toolchains.join(" ") : out.dim("none of the gated tools found yet"));
  const agentNames = m.agents.filter((a) => a !== "cmux");
  row("Agents", agentNames.length ? agentNames.join(", ") : out.dim("none found yet"));
  if (m.agents.includes("cmux")) row("Terminal", "cmux");
  console.log();
}

function showPlan(m: MachineProfile, t: Tuning, sessions: number, current: Policy | null): void {
  console.log(`\n${out.bold("The plan")}  ${out.dim(`for ${m.memoryGb} GB and ~${sessions} agent sessions`)}`);
  const slots = Object.entries(t.slots)
    .filter(([k]) => ["dotnet", "node", "xcode"].includes(k) || m.toolchains.length === 0)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  console.log(
    `  ${out.bold(String(t.maxConcurrent))} heavy job${t.maxConcurrent === 1 ? "" : "s"} at once  ${out.dim(slots)}`,
  );
  console.log(
    `  ${out.dim(`one at a time below ${t.gate.yellowFreePercent}% free memory, nothing new below ${t.gate.redFreePercent}%`)}`,
  );
  for (const r of t.reasons) console.log(`  ${out.dim(`· ${r}`)}`);
  if (current && !same(current, tunedPolicy(current, t))) {
    console.log(`  ${mark.warn()} your current policy allows ${current.maxConcurrent} at once`);
  }
}

function filesTouched(plan: InstallPlan, list: Agent[]): string[] {
  const home = userHome();
  const files = [`${paths.home}/`, `~/Library/LaunchAgents/ (launchd job)`];
  const rc = (process.env.SHELL ?? "").endsWith("bash") ? "~/.bash_profile" : "~/.zshrc";
  files.push(`${rc} (one PATH line)`);
  for (const a of list) {
    if (!plan.agents.includes(a.id)) continue;
    if (a.id === "claude") files.push(`~/.claude/settings.json (hooks${plan.statusLine ? " + statusline" : ""})`);
    if (a.id === "codex") files.push("~/.codex/hooks.json + AGENTS.md");
    if (a.id === "gemini") files.push("~/.gemini/GEMINI.md");
  }
  if (plan.cmuxDock) files.push("~/.config/cmux/dock.json");
  return files.map((f) => f.replace(home, "~"));
}

export interface SetupOptions {
  yes: boolean;
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  // Must run from the compiled binary: that is what gets installed into ~/.bouncer.
  if (/(^|\/)bun$/.test(process.execPath)) {
    console.error("bouncer install must run from the compiled binary: bun run build && ./dist/bouncer install");
    process.exit(1);
  }
  const ask = interactive() && !opts.yes;
  const machine = scanMachine();
  checkMachine(machine);
  const list = agents();
  const saved = savedChoices();
  const live = liveSessions();
  const current = existsSync(paths.policy) ? safeLoad() : null;

  if (ask) intro(machine);

  try {
    // 1. Agents
    const options = agentOptions(list);
    const detected = options.filter((o) => !o.disabled).map((o) => o.value);
    const defaultAgents = saved.agents?.filter((id) => detected.includes(id)) ?? detected;
    const chosenAgents = ask
      ? await prompt("Which agents should Bouncer connect to?", options, {
          multi: true,
          initial: defaultAgents,
          summaryLabel: "Agents",
        })
      : defaultAgents;

    // 2. How you work
    const sessionDefault = saved.sessions ?? bucketFor(live || 6);
    const [sessions] = ask
      ? await prompt(
          `How many agent sessions do you usually run at once?${live ? out.dim(`  (${live} open right now)`) : ""}`,
          SESSION_BUCKETS,
          { initial: [sessionDefault], summaryLabel: "Sessions" },
        )
      : [sessionDefault];

    // 3. The plan
    const tuning = recommend(machine, sessions!);
    const base = current ?? DEFAULT_POLICY;
    const tuned = tunedPolicy(base, tuning);
    let usePolicy: Policy | null = tuned;
    if (ask) {
      showPlan(machine, tuning, sessions!, current);
      if (current && !same(current, tuned)) {
        const [choice] = await prompt(
          "Your policy differs from what this Mac can take.",
          [
            {
              label: "Use the tuned limits",
              value: "tuned",
              hint: "your other settings are kept; the old file is backed up",
            },
            { label: "Keep my policy", value: "keep" },
          ],
          { summaryLabel: "Policy" },
        );
        usePolicy = choice === "tuned" ? tuned : null;
      } else if (current) usePolicy = null; // already matches: leave the file alone
    } else if (current) usePolicy = null; // --yes never rewrites an existing policy

    // 4. Extras
    const extras: Option<string>[] = [];
    if (chosenAgents.includes("claude")) {
      extras.push({ label: "Claude Code statusline", value: "statusLine", hint: "● bouncer 2 running · 1 waiting" });
    }
    if (hasCmux())
      extras.push({ label: "cmux Dock view", value: "cmuxDock", hint: "live status in cmux's right sidebar" });
    const extraDefaults = extras
      .map((e) => e.value)
      .filter((v) => (v === "statusLine" ? saved.statusLine !== false : saved.cmuxDock !== false));
    const chosenExtras =
      ask && extras.length
        ? await prompt("Extras", extras, { multi: true, initial: extraDefaults, summaryLabel: "Extras" })
        : extraDefaults;

    const plan: InstallPlan = {
      agents: chosenAgents,
      statusLine: chosenExtras.includes("statusLine"),
      cmuxDock: chosenExtras.includes("cmuxDock"),
      policy: usePolicy ? renderPolicy(usePolicy, header(machine, tuning, sessions!)) : null,
      policyNote: usePolicy
        ? `${paths.policy} (tuned: ${usePolicy.maxConcurrent} heavy job${usePolicy.maxConcurrent === 1 ? "" : "s"} at once)`
        : `${paths.policy} (kept yours)`,
    };

    if (ask) {
      console.log(`\n${out.bold("Bouncer will change")}`);
      for (const f of filesTouched(plan, list)) console.log(`  ${out.dim("·")} ${f}`);
      console.log(out.dim("  Every edited file is backed up first; bouncer uninstall undoes all of it."));
      const [go] = await prompt(
        "Install?",
        [
          { label: "Install", value: true },
          { label: "Cancel", value: false },
        ],
        { summaryLabel: "" },
      );
      if (!go) throw new Cancelled();
      console.log();
    } else {
      console.log(out.bold(`Installing Bouncer ${VERSION}`) + out.dim(`  ${describe(machine)}\n`));
    }

    const ok = performInstall(plan);
    writeJson(setupFile(), {
      agents: plan.agents,
      sessions,
      statusLine: plan.statusLine,
      cmuxDock: plan.cmuxDock,
      version: VERSION,
      machine: describe(machine),
    });
    finale(plan, list, ok);
    if (!ok) process.exit(1);
  } catch (e) {
    if (e instanceof Cancelled) {
      console.log(out.dim("\nNothing was changed."));
      process.exit(130);
    }
    throw e;
  }
}

function safeLoad(): Policy | null {
  try {
    return loadPolicy();
  } catch {
    return null;
  }
}

function finale(plan: InstallPlan, list: Agent[], ok: boolean): void {
  if (!ok) {
    console.log(
      `\n${mark.fail()} ${out.bold("The daemon didn't start.")} Run ${out.bold("bouncer doctor")} to see why.`,
    );
    return;
  }
  const followUps = list.filter((a) => plan.agents.includes(a.id) && a.followUp).map((a) => a.followUp!);
  console.log(`\n${mark.ok()} ${out.bold("Bouncer is on duty.")}\n`);
  console.log(`  1. Open a new terminal, and restart agent sessions that were already open.`);
  let n = 2;
  for (const f of followUps) console.log(`  ${n++}. ${f}`);
  console.log(`  ${n++}. ${out.bold("bouncer status")}  ${out.dim("what's running, what's waiting, and why")}`);
  console.log(`  ${n}. ${out.bold("bouncer doctor")}  ${out.dim("if anything looks off")}`);
  console.log(out.dim(`\n  Change any of this later: bouncer setup · Remove everything: bouncer uninstall`));
}

/** `bouncer tune [--apply]`: re-scan the Mac and compare with the current policy. */
export async function tuneCommand(args: string[]): Promise<void> {
  const machine = scanMachine();
  const sessions = savedChoices().sessions ?? bucketFor(liveSessions() || 6);
  const tuning = recommend(machine, sessions);
  const current = safeLoad() ?? DEFAULT_POLICY;
  const tuned = tunedPolicy(current, tuning);
  console.log(`${out.bold("This Mac")}  ${describe(machine)}`);
  console.log(`${out.bold("Sessions")}  ~${sessions} ${out.dim("(bouncer setup to change)")}\n`);
  const row = (k: string, now: number, rec: number) =>
    console.log(
      `  ${padEnd(k, 20)} ${String(now).padStart(3)}  ${now === rec ? out.dim("same") : `${out.yellow("→")} ${rec}`}`,
    );
  console.log(out.dim(`  ${padEnd("", 20)} now  tuned`));
  row("heavy jobs at once", current.maxConcurrent, tuned.maxConcurrent);
  for (const k of ["dotnet", "node", "xcode"]) row(`${k} slot`, current.slots[k] ?? 1, tuned.slots[k] ?? 1);
  row("one-at-a-time below %", current.gate.yellowFreePercent, tuned.gate.yellowFreePercent);
  row("nothing-new below %", current.gate.redFreePercent, tuned.gate.redFreePercent);
  console.log();
  for (const r of tuning.reasons) console.log(out.dim(`  · ${r}`));
  if (same(current, tuned)) {
    console.log(`\n${mark.ok()} Your policy already matches this Mac.`);
    return;
  }
  if (!args.includes("--apply")) {
    console.log(
      out.dim(`\nApply with: bouncer tune --apply  (your other settings are kept; the old file is backed up)`),
    );
    return;
  }
  const { backup } = await import("./files");
  if (existsSync(paths.policy)) backup(paths.policy);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(paths.policy, renderPolicy(tuned, header(machine, tuning, sessions)), { mode: 0o600 });
  console.log(`\n${mark.ok()} Policy tuned. The daemon picks it up within a few seconds.`);
}
