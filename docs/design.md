# Bouncer design

Why Bouncer works the way it does. For how to use it, see the [README](../README.md).

## The problem

Running several AI coding agents on one Mac works until two or three of them start a heavy build
at the same moment. A single `dotnet test` with its compiler server can take 10+ GB; a few
`pnpm build`s and a dozen agent sessions on top push an 18 GB machine past its memory. macOS then
kills processes to survive (Jetsam), and the terminal holding every agent session is often among
them. Every agent loses its context at once.

The usual workaround is to serialize work by hand. Bouncer does that automatically: heavy commands
wait in line for a slot, and memory pressure decides how many may run at once.

## Principles

1. **Delay, never deny.** A denied agent improvises, usually badly. A queued command just waits.
2. **Fail open.** If Bouncer is broken, unreachable or misconfigured, commands run as if it
   weren't installed. It must never be the reason work stops.
3. **Only the human sets priority.** Agents ask for whatever finishes their own task first.
4. **Never delete what can't be proven regenerable.**
5. **Gate on real memory pressure.** macOS keeps swap full long after pressure is gone, so swap
   is shown but never used to decide.

## Shape

```text
Claude Code PreToolUse hook ──┐
PATH shims (dotnet, pnpm, …)  ├──▶ ~/.bouncer/bouncer.sock ──▶ bouncerd (launchd)
UserPromptSubmit hook ────────┤      JSON lines, protocol v1     ├─ sensors (platform/macos)
bouncer CLI / menu bar app ───┘      connection = lease          ├─ scheduler (pure)
                                                                 ├─ reaper
                                                                 └─ jobs.db (history)
```

One compiled binary (TypeScript on Bun) is the daemon, the CLI, the shims' target and the hooks.
Bun gives a single-file binary and fast startup; every `dotnet`/`pnpm` call pays the shim's startup
(measured at 20-40 ms). The menu bar app (SwiftUI) talks to the daemon only through the CLI, so
there is one implementation of the protocol.

## Decisions

**Fitting the machine.** Setup tiers the heavy-job budget by RAM (under 12 GB: one at a time; 12-24:
two; 24-36: three; 36-64: four; more: six), caps it at half the performance cores (builds are
CPU-bound too), and subtracts agent sessions beyond six at the measured ~0.25 GB each. These are
starting points; every macOS out-of-memory event Bouncer reports is the signal to lower them.

**Agents.** Every agent's builds are queued by the PATH shims. Beyond that, Bouncer uses only what
each agent documents: Claude Code and Codex hooks (Codex has no background runs, so queued builds
wait in the foreground there), and plain instruction files for agents without hooks. Codex hooks
see a different session id than the builds they start, which is why priority also matches by
project folder.

**Slots and the gate.** Each heavy tool maps to a slot with a capacity (`dotnet 1`, `node 2`, …)
plus a global `maxConcurrent`. The kernel's pressure level and free-memory percentage give three
states: *Clear* (slots decide), *Tight* (one heavy job at a time), *Holding the door* (nothing
starts; normal jobs are stopped, newest first, at most one every 30 s).

**The connection is the lease.** A shim holds its socket connection for the job's lifetime. If the
shim dies, the slot frees. Live state stays in memory; the database is history only.

**Where the wait happens.** In a terminal, the shim blocks in the foreground. In Claude Code, a
foreground wait would hit the Bash tool's timeout, so the PreToolUse hook asks the daemon whether
the command would queue and, if so, rewrites the call to run in the background. The agent is
notified when it finishes. In permission modes where rewriting would also skip the user's
permission prompt, the hook instead asks the agent to resubmit in the background.

**Priority.** Raised only from the user's own prompt ("prioritize this") or the CLI. The
UserPromptSubmit hook sees the human's text, never an agent's output. The PreToolUse hook refuses
agent commands that bypass or reorder the queue. A prioritized job preempts the newest normal job
in its slot: Bouncer kills it and requeues it at the front. Pausing (SIGSTOP) would free no memory.

**Builds Bouncer didn't start.** IDE builds and sessions started before install are found in the
process table (root of each build tree only) and occupy slots. They are never stopped: Bouncer has
no lease on them.

**Compiler servers.** `VBCSCompiler`, MSBuild node-reuse workers and the Razor server outlive the
build that started them, often at many GB. They are stopped 30 s after the last dotnet build, or at
once when memory is critical, and never while any dotnet build runs. They are matched on the
executable and first argument only, never on free text.

**Swapped-out daemon.** Under memory pressure macOS may swap the daemon out, so it can take seconds
to accept a connection: exactly when gating matters. Shims wait up to 10 s for a live daemon. A
dead one refuses instantly, so fail-open stays fast.

**Upgrades.** Installed via Homebrew, `~/.bouncer/bouncer` links to the version-independent `opt`
path. The daemon notices its binary changed and restarts once nothing runs; clients that find the
socket but no listener retry for 2 s, so a restart never opens a fail-open window.

**Environment.** The compiled binary never loads `.env` or `bunfig.toml` from the directory it runs
in: it runs inside users' projects. Scheduled jobs store an allowlist of variables, never the full
environment.

**Janitor.** Caches are cleared by their own tools. Build output is deleted only in worktrees idle
for 14+ days, only where `git check-ignore` confirms it, and never where an agent session is
working. git runs with `--no-optional-locks` so inspecting a worktree never makes it look active.

## Not built yet

- Linux and Windows (`src/platform/` is the boundary; only macOS is implemented)
- A Codex pre-tool hook (Codex builds are still queued by the shims, but waits are foreground)
- An MCP server for agents to read the queue and schedule work
- Per-job memory and time budgets for the reaper
